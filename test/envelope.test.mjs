// pattern: functional-core
// Envelope wrap/unwrap for schemaVersion (docs/schema.md §5.6). The readers are
// deliberately tolerant: Claude hand-writes attested.json / merge-decisions.json
// during triage, so a bare legacy file must unwrap unchanged and never break the
// build.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SCHEMA_VERSION,
  stampSource,
  unwrapDecisions,
  unwrapEntries,
  wrapDecisions,
  wrapEntries,
} from '../scripts/lib/envelope.mjs'

test('SCHEMA_VERSION is 1', () => {
  assert.equal(SCHEMA_VERSION, 1)
})

test('wrapEntries produces a versioned envelope', () => {
  const e = { 'linkedin:jane-wilson': { relationship: 'colleague' } }
  assert.deepEqual(wrapEntries(e), { schemaVersion: 1, entries: e })
})

test('unwrapEntries reads a wrapped envelope', () => {
  const e = { 'facebook:jane-em': { relationship: 'cousin' } }
  assert.deepEqual(unwrapEntries({ schemaVersion: 1, entries: e }), e)
})

test('unwrapEntries tolerates a bare legacy map (record keys always contain ":")', () => {
  const bare = { 'google:jwilson': { relationship: 'roommate' } }
  assert.deepEqual(unwrapEntries(bare), bare)
})

test('unwrapEntries round-trips through wrap', () => {
  const e = { 'manual:dave-chen': { context: 'met at kickball' } }
  assert.deepEqual(unwrapEntries(wrapEntries(e)), e)
})

test('unwrapEntries handles empty and missing input', () => {
  assert.deepEqual(unwrapEntries({}), {})
  assert.deepEqual(unwrapEntries({ schemaVersion: 1, entries: {} }), {})
  assert.deepEqual(unwrapEntries(null), {})
  assert.deepEqual(unwrapEntries(undefined), {})
})

test('wrapDecisions produces a versioned envelope', () => {
  const d = [{ keys: ['a', 'b'], verdict: 'same' }]
  assert.deepEqual(wrapDecisions(d), { schemaVersion: 1, decisions: d })
})

test('unwrapDecisions reads a wrapped envelope', () => {
  const d = [{ keys: ['a', 'b'], verdict: 'different' }]
  assert.deepEqual(unwrapDecisions({ schemaVersion: 1, decisions: d }), d)
})

test('unwrapDecisions tolerates a bare legacy array', () => {
  const bare = [{ keys: ['x', 'y'], verdict: 'same' }]
  assert.deepEqual(unwrapDecisions(bare), bare)
})

test('unwrapDecisions handles empty and missing input', () => {
  assert.deepEqual(unwrapDecisions([]), [])
  assert.deepEqual(unwrapDecisions({ schemaVersion: 1, decisions: [] }), [])
  assert.deepEqual(unwrapDecisions(null), [])
  assert.deepEqual(unwrapDecisions(undefined), [])
})

test('stampSource adds schemaVersion as a sibling key, preserving the rest', () => {
  const src = { source: 'linkedin', importedAt: '2026-07-22', records: [{ sourceId: 'a' }] }
  assert.deepEqual(stampSource(src), { schemaVersion: 1, ...src })
})

test('stampSource forces THIS build version even if the input already carries one', () => {
  // Re-stamping migrated data must reflect the current build, not the old value.
  assert.equal(stampSource({ schemaVersion: 99, source: 'x' }).schemaVersion, 1)
})

test('unwrapEntries FAILS LOUD on a malformed wrapped envelope instead of returning empty', () => {
  assert.throws(() => unwrapEntries({ schemaVersion: 1, entries: null }))
  assert.throws(() => unwrapEntries({ schemaVersion: 1 })) // wrapped intent, no entries
  assert.throws(() => unwrapEntries({ schemaVersion: 1, decisions: [] })) // wrong payload key
})

test('unwrapEntries FAILS LOUD on a record key stranded beside "entries" (mixed shape)', () => {
  assert.throws(
    () => unwrapEntries({ schemaVersion: 1, entries: { 'facebook:a': {} }, 'facebook:b': { relationship: 'cousin' } }),
    /facebook:b/,
  )
})

test('unwrapDecisions FAILS LOUD on a malformed wrapped envelope or a non-array/object', () => {
  assert.throws(() => unwrapDecisions({ schemaVersion: 1, decisions: null }))
  assert.throws(() => unwrapDecisions({ schemaVersion: 1 }))
  assert.throws(() => unwrapDecisions({ foo: 'bar' })) // plain object, neither shape
})

test('both unwrappers refuse a schemaVersion newer than this build', () => {
  assert.throws(() => unwrapEntries({ schemaVersion: 2, entries: {} }), /newer/)
  assert.throws(() => unwrapDecisions({ schemaVersion: 2, decisions: [] }), /newer/)
})
