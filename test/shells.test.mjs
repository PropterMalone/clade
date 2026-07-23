// pattern: functional-core
// Shell scripts must be importable without running their CLI bodies (so pure
// exports are testable and importing enrich-batch can never spawn claude -p).

import assert from 'node:assert/strict'
import { test } from 'node:test'

test('all four shells import without executing their CLI body', async () => {
  // Would throw / exit / hit the filesystem-or-network if entrypoint guards were missing.
  await import('../scripts/build-index.mjs')
  await import('../scripts/enrich-batch.mjs')
  await import('../scripts/export-knowledge.mjs')
  await import('../search.mjs')
  assert.ok(true)
})

test('matchesQuery ANDs words across all fields', async () => {
  const { matchesQuery } = await import('../search.mjs')
  const c = {
    name: 'Jane Wilson',
    employer: 'Deloitte',
    domains: ['energy', 'climate'],
    attested: { relationship: 'college roommate' },
    handles: { bluesky: 'jane.bsky.social' },
  }
  assert.equal(matchesQuery(c, 'jane deloitte'), true)
  assert.equal(matchesQuery(c, 'energy roommate'), true)
  assert.equal(matchesQuery(c, 'jane acme'), false)
  assert.equal(matchesQuery(c, ''), true)
})

test('export skipReason distinguishes junk classes and keeps digit-start handles', async () => {
  const { skipReason } = await import('../scripts/export-knowledge.mjs')
  assert.equal(skipReason('linkedin:jane-wilson'), 'key-shaped')
  assert.equal(skipReason('#BAL - Check Balance'), 'shortcode')
  assert.equal(skipReason('12345'), 'no-letters')
  assert.equal(skipReason('420blaze_dave'), null)
  assert.equal(skipReason('Jane Wilson'), null)
})
