// pattern: functional-core
// Pins the verified findings of docs/decisions/_angel-review-2026-07-17.md.
// Test numbering follows that report's test plan.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assignIds,
  buildIndex,
  employerOverlap,
  employersConflict,
  foldGroup,
  nameMatch,
  pickEnrichment,
  resolveRecords,
} from '../scripts/lib/resolve.mjs'

const rec = (key, name, extra = {}) => ({
  key,
  source: key.split(':')[0],
  sourceId: key.split(':')[1],
  name,
  ...extra,
})

const groupKeys = (groups) => groups.map((g) => g.map((r) => r.key).sort())
const groupOf = (groups, key) => groups.find((g) => g.some((r) => r.key === key))

// 1. C1 — blocked-pair transitive bridge
test('a "different" ruling holds even when a third record bridges both sides', () => {
  // bridge record FIRST in index order: the order that defeated the old snapshot
  const records = [
    rec('bluesky:z1', 'John Smith', { employer: 'IBM' }),
    rec('facebook:y1', 'John Smith', { employer: 'IBM Watson' }),
    rec('linkedin:x1', 'John Smith', { employer: 'IBM Global Services' }),
  ]
  const decisions = [{ keys: ['linkedin:x1', 'facebook:y1'], verdict: 'different' }]
  const { groups } = resolveRecords(records, decisions)
  const gx = groupOf(groups, 'linkedin:x1')
  assert.ok(!gx.some((r) => r.key === 'facebook:y1'), 'ruled-different pair must never share a group')

  // and in the reverse order too
  const { groups: g2 } = resolveRecords([...records].reverse(), decisions)
  const gx2 = groupOf(g2, 'linkedin:x1')
  assert.ok(!gx2.some((r) => r.key === 'facebook:y1'))
})

// 2. C2 — exact name, both employers blank → candidate, not auto-merge
test('exact-name-unique pair with no employer signal goes to candidates, not a silent merge', () => {
  const records = [
    rec('linkedin:mc1', 'Michael Chen'),
    rec('facebook:mc2', 'Michael Chen'),
  ]
  const { groups, candidates } = resolveRecords(records)
  assert.equal(groups.length, 2, 'must not merge on name alone')
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].reason, 'exact-name')
})

test('exact-name pair with employer overlap still auto-merges', () => {
  const records = [
    rec('linkedin:a', 'Jane Doe', { employer: 'Deloitte Consulting' }),
    rec('google-contacts:b', 'Jane Doe', { employer: 'Deloitte' }),
  ]
  const { groups, candidates } = resolveRecords(records)
  assert.equal(groups.length, 1)
  assert.equal(candidates.length, 0)
})

// 3. C3 — fold picks winners by confidence/recency/source authority, not array order
test('fold keeps the high-confidence enrichment over a later low-confidence one', () => {
  const enrichments = {
    'gmail:b': { confidence: 'unidentified', enrichedAt: '2026-06-01T00:00:00Z', notes: 'nope' },
    'linkedin:a': { confidence: 'high', realName: 'Jane Q. Wilson', employer: 'Deloitte', enrichedAt: '2026-01-01T00:00:00Z' },
  }
  // group array order puts the unidentified one last — .at(-1) would have picked it
  const picked = pickEnrichment(['gmail:b', 'linkedin:a'], enrichments)
  assert.equal(picked.confidence, 'high')

  const group = [
    rec('gmail:b', 'Jane Wilson', { emails: ['jw@x.com'] }),
    rec('linkedin:a', 'Jane Wilson', { emails: ['jw@x.com'] }),
  ]
  const folded = foldGroup(group, { enrichments })
  assert.equal(folded.confidence, 'high')
  assert.equal(folded.name, 'Jane Q. Wilson')
})

test('fold prefers linkedin-source employer over an alphabetically-earlier stale source', () => {
  const group = [
    rec('facebook:f1', 'Sam Roe', { employer: 'Defunct Startup', title: 'Intern', connectedOn: '2015-06-01' }),
    rec('linkedin:l1', 'Sam Roe', { employer: 'Deloitte', title: 'Partner', connectedOn: '2024-01-01' }),
  ]
  const folded = foldGroup(group, {})
  assert.equal(folded.employer, 'Deloitte')
  assert.equal(folded.profession, 'Partner')
  assert.match(folded.notes, /Defunct Startup/, 'losing employer must stay visible in notes')
})

// 4. C4 — short employer names ("3M", "GE", "AT&T") must overlap, not conflict
test('short company names overlap and never read as a conflict', () => {
  for (const co of ['3M', 'GE', 'HP', 'EY', 'AT&T']) {
    const a = { employer: co }
    const b = { employer: co }
    assert.equal(employerOverlap(a, b), true, `${co} must overlap itself`)
    assert.equal(employersConflict(a, b), false, `${co} must not conflict with itself`)
  }
  const records = [
    rec('linkedin:j1', 'Jane Doe', { employer: '3M' }),
    rec('google-contacts:j2', 'Jane Doe', { employer: '3M' }),
  ]
  const { groups } = resolveRecords(records)
  assert.equal(groups.length, 1, 'same name at 3M must merge')
})

test('generic corporate words do not create employer overlap', () => {
  assert.equal(employerOverlap({ employer: 'Ford Motor Company' }, { employer: 'Acme Company' }), false)
})

// 5. C5 + non-string emails/phones — no false merge, no crash
test('non-string handle placeholders never link records', () => {
  const records = [
    rec('facebook:h1', 'Ann Ash', { handles: { bluesky: null } }),
    rec('linkedin:h2', 'Bea Birch', { handles: { bluesky: null } }),
  ]
  const { groups } = resolveRecords(records)
  assert.equal(groups.length, 2)
})

test('non-string emails/phones are warn-and-skipped, not a crash or a merge', () => {
  const records = [
    rec('gmail:e1', 'Carl Cole', { emails: [null], phones: [15551234567] }),
    rec('facebook:e2', 'Dana Dunn', { emails: [null], phones: [15551234567] }),
  ]
  const { groups, warnings } = resolveRecords(records)
  assert.equal(groups.length, 2)
  assert.ok(warnings.some((w) => /non-string/.test(w)))
})

// 6. employer-conflict truth table
test('employersConflict truth table', () => {
  assert.equal(employersConflict({ employer: 'IBM Global' }, { employer: 'IBM' }), false) // both present, overlap
  assert.equal(Boolean(employersConflict({ employer: 'Acme Widgets' }, { employer: 'IBM' })), true) // both present, no overlap
  assert.equal(Boolean(employersConflict({}, {})), false) // both blank
  assert.equal(Boolean(employersConflict({ employer: 'IBM' }, {})), false) // one blank
})

// 7. fuzzy thresholds pinned
test('nameMatch threshold boundaries', () => {
  assert.equal(nameMatch('John Smith', 'John Smith'), 1)
  const initialism = nameMatch('J Smith', 'John Smith') // 0.825: candidate, never auto-merge
  assert.ok(initialism >= 0.8 && initialism < 0.9, `got ${initialism}`)
  const variant = nameMatch('Jon Smith', 'John Smith') // 0.65: below candidate floor
  assert.ok(variant < 0.8, `got ${variant}`)
  const middle = nameMatch('John Michael Smith', 'John Smith') // ~0.77: below candidate floor
  assert.ok(middle < 0.8, `got ${middle}`)
})

test('candidate-range pair lands in candidates, not merged', () => {
  const records = [
    rec('linkedin:s1', 'J Smith', { employer: 'Acme' }),
    rec('google-contacts:s2', 'John Smith'),
  ]
  const { groups, candidates } = resolveRecords(records)
  assert.equal(groups.length, 2)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].reason, 'fuzzy')
})

// 8. id uniqueness across literal-suffix collisions
test('assignIds never collides, even against a literal "Name 2"', () => {
  const entries = [
    { name: 'Jane Wilson' },
    { name: 'Jane Wilson' },
    { name: 'Jane Wilson 2' },
  ]
  assignIds(entries)
  const ids = entries.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length, `ids must be unique, got ${ids}`)
})

// integration: the original verified repro, end to end through buildIndex
test('buildIndex end-to-end honors rulings and routes blank-employer exact names to candidates', () => {
  const out = buildIndex({
    sources: [
      { source: 'bluesky', records: [{ sourceId: 'z1', name: 'John Smith', employer: 'IBM' }] },
      { source: 'facebook', records: [{ sourceId: 'y1', name: 'John Smith', employer: 'IBM Watson' }, { sourceId: 'mc2', name: 'Michael Chen' }] },
      { source: 'linkedin', records: [{ sourceId: 'x1', name: 'John Smith', employer: 'IBM Global Services' }, { sourceId: 'mc1', name: 'Michael Chen' }] },
    ],
    decisions: [{ keys: ['linkedin:x1', 'facebook:y1'], verdict: 'different' }],
  })
  const withBoth = out.unified.filter(
    (p) => p.keys.includes('linkedin:x1') && p.keys.includes('facebook:y1'),
  )
  assert.equal(withBoth.length, 0, 'ruled-different pair fused in final index')
  const chens = out.unified.filter((p) => p.name === 'Michael Chen')
  assert.equal(chens.length, 2, 'blank-employer Michael Chens must stay separate')
  assert.ok(out.candidates.some((c) => c.reason === 'exact-name'))
})

test('unknown decision keys warn instead of silently no-opping', () => {
  const { warnings } = resolveRecords(
    [rec('linkedin:a', 'A B')],
    [{ keys: ['linkedin:a', 'typo:zzz'], verdict: 'different' }],
  )
  assert.ok(warnings.some((w) => /unknown key/.test(w)))
})

test('name falls back to email localpart, not a raw record key', () => {
  const folded = foldGroup([rec('google-contacts:g1', '', { emails: ['pat.lee@example.com'] })], {})
  assert.equal(folded.name, 'pat.lee')
})

// shared-identifier policy (2026-07-18b): phones/emails are shared between
// real people — corroboration required before they merge.
test('household landline shared by three no-name-overlap records never auto-merges', () => {
  const records = [
    rec('google-contacts:house', "Dana's Parents House Line", { phones: ['(555) 036-8218'] }),
    rec('facebook:edna', 'Wilma Foster', { phones: ['15550368218'] }),
    rec('linkedin:kevin', 'Hank Foster', { phones: ['555-036-8218'] }),
  ]
  const { groups, candidates } = resolveRecords(records)
  assert.equal(groups.length, 3)
  const shared = candidates.filter((c) => c.reason === 'shared-phone')
  assert.equal(shared.length, 2)
  assert.match(shared[0].identifier, /^phone:/)
})

test('shared email between disagreeing multi-token names goes to candidates, not a merge', () => {
  const records = [
    rec('google-contacts:a', 'Nora Quill', { emails: ['shared@example.com'] }),
    rec('linkedin:g', 'Theo Marsh', { emails: ['shared@example.com'] }),
  ]
  const { groups, candidates } = resolveRecords(records)
  assert.equal(groups.length, 2)
  assert.equal(candidates[0].reason, 'shared-email')
})

test('shared email still auto-merges when a name is single-token or names corroborate', () => {
  const single = resolveRecords([
    rec('gmail:j', 'jwilson', { emails: ['jw@x.com'] }),
    rec('linkedin:jw', 'Jennifer Wilson', { emails: ['jw@x.com'] }),
  ])
  assert.equal(single.groups.length, 1)
  const corroborated = resolveRecords([
    rec('google-contacts:d1', 'Jane Doe', { phones: ['202-555-0101'] }),
    rec('facebook:d2', 'Jane Doe', { phones: ['2025550101'] }),
  ])
  assert.equal(corroborated.groups.length, 1)
})

test('a ruling settles a shared-identifier pair permanently', () => {
  const records = [
    rec('google-contacts:k', 'Pat Alvarez', { phones: ['5550142716'] }),
    rec('google-contacts2:d', 'Casey Bloom', { phones: ['5550142716'] }),
  ]
  const diff = resolveRecords(records, [{ keys: ['google-contacts:k', 'google-contacts2:d'], verdict: 'different' }])
  assert.equal(diff.groups.length, 2)
  assert.equal(diff.candidates.length, 0, 'ruled pair must not resurface')
  const same = resolveRecords(records, [{ keys: ['google-contacts:k', 'google-contacts2:d'], verdict: 'same' }])
  assert.equal(same.groups.length, 1)
})

test('junk email values never become merge identifiers', () => {
  const records = [
    rec('google-contacts:a2', 'Nora Quill', { emails: ['* Other'] }),
    rec('google-contacts2:g2', 'Theo Marsh', { emails: ['* Other'] }),
  ]
  const { groups, candidates } = resolveRecords(records)
  assert.equal(groups.length, 2)
  assert.equal(candidates.length, 0, 'junk strings are not identifiers at all')
})

// ADR-04 orientation: DIDs are the stable atproto identity key
test('a shared atproto DID merges records regardless of display-name drift', () => {
  const records = [
    rec('bluesky:cool.bsky.social', 'cool poster', { did: 'did:plc:abc123xyz' }),
    rec('manual:jane', 'Jane Wilson', { did: 'did:plc:abc123xyz' }),
  ]
  const { groups } = resolveRecords(records)
  assert.equal(groups.length, 1, 'same DID = same identity by construction')
  const folded = foldGroup(groups[0], {})
  assert.deepEqual(folded.dids, ['did:plc:abc123xyz'])
})

test('absent or junk did values never link', () => {
  const records = [
    rec('bluesky:a', 'Ann A', { did: '' }),
    rec('bluesky2:b', 'Bea B', { did: null }),
  ]
  assert.equal(resolveRecords(records).groups.length, 2)
})

// angel-review 2026-07-19 Criticals pinned
test('same-surname pair on a shared phone defers — surname is not corroboration', () => {
  const records = [
    rec('facebook:edna2', 'Wilma Foster', { phones: ['5550368218'] }),
    rec('linkedin:kevin2', 'Hank Foster', { phones: ['5550368218'] }),
  ]
  const { groups, candidates } = resolveRecords(records)
  assert.equal(groups.length, 2, 'spouses/siblings share landline AND surname — must not merge')
  assert.equal(candidates[0].reason, 'shared-phone')
})

test('shared-first-name pair on a shared email defers', () => {
  const records = [
    rec('gmail:js', 'John Smith', { emails: ['shared@x.com'] }),
    rec('facebook:jd', 'John Doe', { emails: ['shared@x.com'] }),
  ]
  const { groups, candidates } = resolveRecords(records)
  assert.equal(groups.length, 2)
  assert.equal(candidates[0].reason, 'shared-email')
})

test('truly matching names on a shared phone still auto-merge', () => {
  const { groups } = resolveRecords([
    rec('google-contacts:jd1', 'Jane Doe', { phones: ['5550101234'] }),
    rec('facebook:jd2', 'Jane Doe', { phones: ['5550101234'] }),
  ])
  assert.equal(groups.length, 1)
})

test('non-did-shaped strings never link as DIDs', () => {
  const { groups } = resolveRecords([
    rec('manual:x', 'Ann A', { did: 'unknown' }),
    rec('manual2:y', 'Bea B', { did: 'unknown' }),
  ])
  assert.equal(groups.length, 2)
})

// §5.5 — social-graph edge folds through, strongest wins
test('fold surfaces the strongest edge across a merged group', () => {
  const folded = foldGroup(
    [rec('bluesky:a', 'Jo Bee', { edge: 'follower' }), rec('manual:a', 'Jo Bee', { edge: 'mutual' })],
    {},
  )
  assert.equal(folded.edge, 'mutual')
})

test('fold reports a lone edge when only one source carries it', () => {
  const folded = foldGroup([rec('bluesky:a', 'Jo Bee', { edge: 'following' })], {})
  assert.equal(folded.edge, 'following')
})

test('fold edge is null when no source carries one, and junk edges are ignored', () => {
  assert.equal(foldGroup([rec('linkedin:a', 'Jo Bee')], {}).edge, null)
  assert.equal(foldGroup([rec('bluesky:a', 'Jo Bee', { edge: 'acquaintance' })], {}).edge, null)
})

test('fold edge ignores Object.prototype keys and never lets one displace a real edge', () => {
  // "toString" is a live prototype method — must not survive, and must not win a sort.
  assert.equal(foldGroup([rec('bluesky:a', 'Jo Bee', { edge: 'toString' })], {}).edge, null)
  assert.equal(
    foldGroup([rec('bluesky:a', 'Jo Bee', { edge: 'toString' }), rec('manual:a', 'Jo Bee', { edge: 'mutual' })], {}).edge,
    'mutual',
  )
})

// §5.3 — name provenance is tagged so a future networked build excludes bridges mechanically
test('nameSource tags where the display name came from', () => {
  const raw = foldGroup([rec('linkedin:a', 'Jane Wilson')], {})
  assert.equal(raw.name, 'Jane Wilson')
  assert.equal(raw.nameSource, 'raw')

  const att = foldGroup([rec('facebook:jane-em', 'Jane Em')], {
    attested: { 'facebook:jane-em': { realName: 'Jane Wilson' } },
  })
  assert.equal(att.name, 'Jane Wilson')
  assert.equal(att.nameSource, 'attested')

  const enr = foldGroup([rec('bluesky:jw', 'jaydub')], {
    enrichments: { 'bluesky:jw': { realName: 'Jane Wilson', confidence: 'high' } },
  })
  assert.equal(enr.name, 'Jane Wilson')
  assert.equal(enr.nameSource, 'enrichment')
})

test('attested realName outranks an enrichment realName (documented authority order)', () => {
  const folded = foldGroup([rec('facebook:jane-em', 'Jane Em')], {
    attested: { 'facebook:jane-em': { realName: 'Jane Wilson' } },
    enrichments: { 'facebook:jane-em': { realName: 'WRONG PERSON', confidence: 'high' } },
  })
  assert.equal(folded.name, 'Jane Wilson')
  assert.equal(folded.nameSource, 'attested')
})

test('a low/medium-confidence enrichment realName is NOT adopted as the display name', () => {
  // Only high-confidence web research may set a canonical name (unmasking gate);
  // a low-confidence guess falls through to the raw display name.
  const folded = foldGroup([rec('bluesky:jw', 'jaydub')], {
    enrichments: { 'bluesky:jw': { realName: 'Maybe Someone', confidence: 'low' } },
  })
  assert.equal(folded.name, 'jaydub')
  assert.equal(folded.nameSource, 'raw')
})
