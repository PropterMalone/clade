// pattern: functional-core
// Spec for enrich-status's pure reporting logic. The shell (path resolution,
// printing) is thin; what matters is that the backlog summary matches what a
// real run would take — it reuses planWork/filterByUnitKind rather than
// reimplementing selection, and these pin that agreement.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONFIRM_GROUP_SIZE } from '../scripts/lib/enrich-core.mjs'
import { scanBanks } from '../scripts/enrich-batch.mjs'
import { humanAge, summarize } from '../scripts/enrich-status.mjs'

const withUrl = (i) => ({ name: `Rich ${i}`, linkedinUrl: `https://www.linkedin.com/in/rich${i}` })
const thin = (i) => ({ name: `Thin ${i}` })

test('summarize splits solo vs confirm the way planWork does', () => {
  const s = summarize([...Array.from({ length: 8 }, (_, i) => withUrl(i)), ...Array.from({ length: 3 }, (_, i) => thin(i))])
  assert.equal(s.backlog, 11)
  assert.equal(s.confirm, 8)
  assert.equal(s.solo, 3)
  // 8 confirms batch into 2 sessions of 4, plus 3 solo sessions.
  assert.equal(s.units, 8 / CONFIRM_GROUP_SIZE + 3)
})

test('summarize counts work units, not contacts — a LinkedIn-heavy backlog is cheaper per head', () => {
  const heavy = summarize(Array.from({ length: 40 }, (_, i) => withUrl(i)))
  const thinOnly = summarize(Array.from({ length: 40 }, (_, i) => thin(i)))
  assert.equal(heavy.units, 10)
  assert.equal(thinOnly.units, 40)
  assert.ok(heavy.units < thinOnly.units, 'the whole point of the confirm tier')
})

test('summarize handles an empty backlog without dividing by zero', () => {
  const s = summarize([])
  assert.deepEqual([s.backlog, s.solo, s.confirm, s.units], [0, 0, 0, 0])
})

test('a confirm remainder still costs a session', () => {
  // 5 confirms = one full group of 4 plus a remainder of 1, which planWork
  // runs as its own unit — so 2 sessions, not 1.25.
  const s = summarize(Array.from({ length: 5 }, (_, i) => withUrl(i)))
  assert.equal(s.units, 2)
})

const banks = (files) => ({
  dir: '/fake',
  exists: () => true,
  readDir: () => Object.keys(files),
  readFile: (p) => files[p.split('/').pop()],
})

test('scanBanks returns nothing when the bank directory does not exist', () => {
  const r = scanBanks({ dir: '/nope', exists: () => false })
  assert.equal(r.lastBankedAt, null)
  assert.equal(r.attempted.size, 0)
})

test('scanBanks takes the newest enrichedAt across all banks', () => {
  const r = scanBanks(banks({
    'a.json': JSON.stringify({ schemaVersion: 1, entries: { k1: { confidence: 'high', enrichedAt: '2026-01-01T00:00:00Z' } } }),
    'b.json': JSON.stringify({ schemaVersion: 1, entries: { k2: { confidence: 'low', enrichedAt: '2026-07-25T12:00:00Z' } } }),
    'c.json': JSON.stringify({ schemaVersion: 1, entries: { k3: { confidence: 'low' } } }), // no timestamp
  }))
  assert.equal(r.lastBankedAt, '2026-07-25T12:00:00Z')
  assert.deepEqual([...r.attempted].sort(), ['k1', 'k2', 'k3'])
})

test('scanBanks ignores a malformed record for BOTH answers, not just one', () => {
  // A hand-edited entry that kept enrichedAt but lost confidence is not
  // "attempted" (it gets retried) — so it must not be reported as the last
  // successful bank either. These two answers used to be computed separately
  // and disagreed here (review).
  const r = scanBanks(banks({
    'good.json': JSON.stringify({ entries: { k1: { confidence: 'high', enrichedAt: '2026-01-01T00:00:00Z' } } }),
    'bad.json': JSON.stringify({ entries: { k2: { enrichedAt: '2026-12-31T00:00:00Z' } } }),
  }))
  assert.equal(r.lastBankedAt, '2026-01-01T00:00:00Z', 'malformed record must not win "last banked"')
  assert.ok(!r.attempted.has('k2'), 'malformed record must stay retryable')
})

test('scanBanks survives an unreadable bank rather than failing the report', () => {
  const r = scanBanks(banks({
    'ok.json': JSON.stringify({ entries: { k: { confidence: 'low', enrichedAt: '2026-05-05T00:00:00Z' } } }),
    'broken.json': '{not json',
  }))
  assert.equal(r.lastBankedAt, '2026-05-05T00:00:00Z')
})

test('humanAge reads in the largest useful unit', () => {
  assert.equal(humanAge(30), 'just now')
  assert.equal(humanAge(60 * 5), '5m ago')
  assert.equal(humanAge(3600 * 2), '2h ago')
  assert.equal(humanAge(86400 * 6), '6d ago')
  assert.equal(humanAge(86400 * 45), '1mo ago')
  assert.equal(humanAge(Number.NaN), 'unknown')
})
