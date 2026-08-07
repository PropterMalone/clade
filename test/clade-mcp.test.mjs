// pattern: functional-core
// Spec for the stdio MCP reference server (scripts/clade-mcp.mjs). Exercises the
// pure callTool/handleRpc/brief/cleanRecord exports against an in-memory index —
// the transport loop is the thin part; the contract in docs/mcp-kit.md is what
// has to hold. Every case here corresponds to an review 2026-07-25 finding.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brief, callTool, cleanRecord, handleRpc } from '../scripts/clade-mcp.mjs'

const INDEX = [
  {
    id: 'a1',
    name: 'Dana Reyes',
    keys: ['linkedin:dana-reyes'],
    sources: ['linkedin', 'gmail'],
    emails: ['dana@example.com'],
    profession: 'Security Engineer',
    employer: 'HackerOne',
    domains: ['application security'],
    labels: [],
    tier: 'multi-source',
    confidence: 'high',
    attested: { relationship: 'met at a conference' },
  },
  {
    id: 'a2',
    name: 'Dana Whitfield',
    keys: ['facebook:dana-w'],
    sources: ['facebook'],
    emails: [],
    domains: [],
    labels: [],
    tier: 'facebook-only',
    confidence: 'none',
    attested: null,
  },
  {
    id: 'a3',
    name: 'Sam Okafor',
    keys: ['gmail:sokafor'],
    sources: ['gmail'],
    emails: ['sam@example.com'],
    profession: 'CTO',
    employer: 'Northwind',
    domains: ['energy policy'],
    labels: [],
    tier: 'gmail-only',
    confidence: 'medium',
    attested: null,
  },
]

test('get_contact disambiguates on ANY multi-match, never dumps records', () => {
  // Two "Dana"s. Returning both full records would hand over every phone, note,
  // and attested context for a person nobody asked for — the bulk-read failure
  // the kit exists to prevent. A brief line each (same shape search_contacts
  // already returns) is the disambiguation affordance; serialized records aren't.
  const out = callTool('get_contact', { name: 'Dana' }, INDEX)
  assert.match(out, /2 contacts match/)
  assert.ok(!out.includes('"keys":'), 'must not serialize records on an ambiguous name')
  assert.ok(!out.includes('"tier":'), 'must not serialize records on an ambiguous name')
  assert.match(out, /linkedin:dana-reyes/, 'offers durable keys to narrow with')
  assert.match(out, /facebook:dana-w/)
})

test('get_contact returns the full record only for an unambiguous name', () => {
  const out = callTool('get_contact', { name: 'Okafor' }, INDEX)
  assert.match(out, /sam@example\.com/)
  assert.match(out, /"tier": "gmail-only"/)
})

test('get_contact by durable key returns one record', () => {
  const out = callTool('get_contact', { key: 'facebook:dana-w' }, INDEX)
  assert.match(out, /Dana Whitfield/)
  assert.ok(!out.includes('Dana Reyes'))
})

test('get_contact rejects an unknown key without falling back to name search', () => {
  const out = callTool('get_contact', { key: 'linkedin:nobody' }, INDEX)
  assert.match(out, /No contact with key/)
})

test('cleanRecord strips the control bytes JSON.stringify leaves live', () => {
  // JSON.stringify only escapes U+0000–U+001F. DEL (0x7f) and C1 (0x80–0x9f,
  // incl. 8-bit CSI 0x9b / OSC 0x9d) survive verbatim into a terminal client.
  const hostile = { bio: 'ok[31m6ntitle', nested: ['ab'] }
  const cleaned = cleanRecord(hostile)
  const serialized = JSON.stringify(cleaned)
  for (const byte of ['', '', '']) {
    assert.ok(!serialized.includes(byte), `raw ${byte.charCodeAt(0)} must not survive`)
  }
  assert.ok(!cleaned.nested[0].includes(''), 'cleans inside arrays')
})

test('a hostile bio reaches get_contact output with control bytes stripped', () => {
  const idx = [{ ...INDEX[2], bio: 'trust me31m', name: 'Sam Okafor' }]
  const out = callTool('get_contact', { name: 'Okafor' }, idx)
  assert.ok(!out.includes(''))
})

test('brief carries the provenance fields the contract promises', () => {
  const line = brief(INDEX[0])
  assert.match(line, /sources: linkedin,gmail/)
  assert.match(line, /confidence: high/)
  assert.match(line, /key: linkedin:dana-reyes/)
})

test('every contact-data response is fenced with matched open/close markers', () => {
  const cases = [
    callTool('search_contacts', { query: 'dana' }, INDEX),
    callTool('get_contact', { name: 'Dana' }, INDEX), // disambiguation list
    callTool('get_contact', { name: 'Okafor' }, INDEX),
    callTool('get_contact', { key: 'gmail:sokafor' }, INDEX),
  ]
  for (const out of cases) {
    assert.match(out, /^\[BEGIN stored contact data/)
    assert.match(out, /\[END stored contact data\.\]$/)
  }
})

test('search_contacts caps the result count regardless of what is asked', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    ...INDEX[2],
    id: `x${i}`,
    name: `Sam Okafor ${i}`,
    keys: [`gmail:sam${i}`],
  }))
  const out = callTool('search_contacts', { query: 'okafor', limit: 500 }, many)
  assert.match(out, /60 match\(es\) \(showing 25\)/)
})

test('search_contacts refuses an argument-less call rather than returning everyone', () => {
  assert.throws(() => callTool('search_contacts', {}, INDEX), /at least one of/)
})

test('contact_stats reports counts and leaks no names', () => {
  const out = callTool('contact_stats', {}, INDEX)
  assert.match(out, /3 contacts/)
  assert.match(out, /"multi-source":1/)
  for (const c of INDEX) assert.ok(!out.includes(c.name), `${c.name} must not appear in stats`)
})

test('handleRpc: a notification (no id) gets no response', () => {
  assert.equal(handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
})

test('handleRpc: initialize echoes a supported version and refuses to invent one', () => {
  const ok = handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  assert.equal(ok.result.protocolVersion, '2025-06-18')
  // An unimplemented version must not be echoed back as if supported.
  const old = handleRpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  assert.equal(old.result.protocolVersion, '2025-06-18')
})

test('handleRpc: batches and unknown methods are refused, not half-handled', () => {
  assert.equal(handleRpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }]).error.code, -32600)
  assert.equal(handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/nope' }).error.code, -32601)
})

test('handleRpc: tools/list advertises exactly the contract three', () => {
  const names = handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' }).result.tools.map((t) => t.name)
  assert.deepEqual(names, ['search_contacts', 'get_contact', 'contact_stats'])
})

// --- address hold-back (ADR-10) ------------------------------------------------
// get_contact USED TO serialize the whole unified entry, so a new field reached
// the seam with no code change. `location` is meant to; `addresses` must never. This
// test is the mechanical guard — the rule alone would not survive the next
// person who adds a field.

const ADDRESSED_INDEX = [
  {
    id: 'h1',
    name: 'Jane Wilson',
    keys: ['vcard:jane-wilson'],
    sources: ['vcard'],
    emails: ['jane@example.com'],
    profession: 'Nurse Practitioner',
    employer: 'Evanston Health',
    location: 'Evanston, IL',
    addresses: [{ type: 'home', street: '1400 Kestrel Ave', city: 'Evanston', region: 'IL', postal: '60201' }],
    domains: ['nursing'],
    labels: [],
    tier: 'vcard-only',
    confidence: 'high',
    attested: null,
  },
]

const SECRETS = ['1400 Kestrel Ave', '60201', 'addresses']

test('no MCP surface leaks a street address', () => {
  const surfaces = {
    brief: brief(ADDRESSED_INDEX[0]),
    get_contact: callTool('get_contact', { name: 'Jane Wilson' }, ADDRESSED_INDEX),
    search_contacts: callTool('search_contacts', { query: 'nurse' }, ADDRESSED_INDEX),
    search_by_location: callTool('search_contacts', { query: 'evanston' }, ADDRESSED_INDEX),
  }
  for (const [surface, out] of Object.entries(surfaces))
    for (const secret of SECRETS)
      assert.ok(!out.includes(secret), `${surface} leaked hold-back address data: ${secret}`)
})

test('get_contact serves an allow-list: an unknown new field does not reach the seam', () => {
  // The guarantee mcp-kit.md rule 6 asks for. A field added to the index
  // upstream must not ship over the seam until someone adds it deliberately.
  const withNewField = [{ ...ADDRESSED_INDEX[0], interactions: { lastCall: 'NDA executed, 50 min' } }]
  const out = callTool('get_contact', { name: 'Jane Wilson' }, withNewField)
  assert.ok(!out.includes('NDA executed'), 'a field nobody allow-listed must not serialize')
  assert.ok(!out.includes('interactions'))
})

test('get_contact omits `unconfirmed` — a refused claim may describe another person', () => {
  const withRefused = [{ ...ADDRESSED_INDEX[0], unconfirmed: { employer: 'Microsoft' } }]
  const out = callTool('get_contact', { name: 'Jane Wilson' }, withRefused)
  assert.ok(!out.includes('Microsoft'))
})

// The allow-list is depth-1; these two served objects carry keys that must not
// cross the seam, so both are projected (review 2026-08-06).
// Built through buildIndex, NOT hand-assembled: an earlier version of this test
// hand-set `name: 'jaydub'` beside `attested.realName`, a state foldGroup cannot
// produce — so it pinned an unreachable case and could never fail. Review caught
// it by running the real pipeline. Any guard test for a fold-derived invariant
// has to be built by the fold.
test('an attested realName rides the top-level name, not a second nested copy', async () => {
  const { buildIndex } = await import('../scripts/lib/resolve.mjs')
  const { unified } = buildIndex({
    sources: [{ source: 'bluesky', records: [{ sourceId: 'jw', name: 'jaydub', handles: { bluesky: 'jaydub.bsky.social' } }] }],
    attested: { 'bluesky:jw': { relationship: 'cousin', context: 'kickball league', realName: 'Jane Wilson Emerson' } },
  })
  assert.equal(unified[0].name, 'Jane Wilson Emerson', 'the fold promotes it — this is the reachable state')
  assert.equal(unified[0].nameSource, 'attested', 'and tags it, which is how a networked build excludes it')

  const out = callTool('get_contact', { name: 'Jane' }, unified)
  assert.ok(!out.includes('"realName"'), 'the nested duplicate stays off the seam')
  assert.match(out, /"nameSource": "attested"/, 'the provenance a remote deployment must filter on IS served')
  assert.match(out, /cousin/)
})

test('get_contact withholds the enrichment narrative when a claim was refused', () => {
  const refused = [{
    ...ADDRESSED_INDEX[0],
    unconfirmed: { employer: 'Microsoft' },
    enrichment: { confidence: 'medium', enrichedAt: '2026-08-01T00:00:00Z', notes: 'Found a Jane Wilson at Microsoft in Wichita — same name, likely her.' },
  }]
  const out = callTool('get_contact', { name: 'Jane Wilson' }, refused)
  assert.ok(!out.includes('Microsoft'), 'the narrative argues for the claim `unconfirmed` exists to withhold')
  assert.ok(!out.includes('Wichita'))
  assert.match(out, /"confidence": "medium"/, 'provenance still serves')
})

test('an accepted enrichment keeps its narrative on the seam', () => {
  const accepted = [{
    ...ADDRESSED_INDEX[0],
    unconfirmed: null,
    enrichment: { confidence: 'high', enrichedAt: '2026-08-01T00:00:00Z', notes: 'Confirmed via the practice bio page.' },
  }]
  assert.match(callTool('get_contact', { name: 'Jane Wilson' }, accepted), /practice bio page/)
})

test('location IS carried by the MCP surfaces — it is the queryable grade', () => {
  assert.match(brief(ADDRESSED_INDEX[0]), /Evanston, IL/)
  assert.match(callTool('get_contact', { name: 'Jane Wilson' }, ADDRESSED_INDEX), /Evanston, IL/)
  assert.match(callTool('search_contacts', { query: 'evanston' }, ADDRESSED_INDEX), /Jane Wilson/)
})
