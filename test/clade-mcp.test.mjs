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
