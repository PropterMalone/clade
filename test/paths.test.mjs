// pattern: functional-core
// Spec for the CLADE_DATA_DIR resolution seam (scripts/paths.mjs). Exercises the
// pure resolveDataRoot(env, cwd, engineRoot) directly — the imperative dataRoot()
// wrapper (fs existence + stderr echo) is covered by the integration test that
// spawns a shell.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveDataRoot } from '../scripts/paths.mjs'

const ENGINE = '/home/user/Projects/clade'

test('unset CLADE_DATA_DIR → cwd (direct-invocation contract preserved)', () => {
  const { root, warn } = resolveDataRoot({}, '/home/user/Krolodex', ENGINE)
  assert.equal(root, '/home/user/Krolodex')
  assert.equal(warn, null)
})

test('unset + cwd IS the engine repo → returns cwd but warns', () => {
  const { root, warn } = resolveDataRoot({}, ENGINE, ENGINE)
  assert.equal(root, ENGINE)
  assert.match(warn, /Clade engine repo itself/)
})

test('absolute CLADE_DATA_DIR outside the repo → that path, no warning', () => {
  const { root, warn } = resolveDataRoot(
    { CLADE_DATA_DIR: '/home/user/Krolodex' },
    ENGINE,
    ENGINE,
  )
  assert.equal(root, '/home/user/Krolodex')
  assert.equal(warn, null)
})

test('relative CLADE_DATA_DIR → throws (would resolve inside cwd)', () => {
  assert.throws(
    () => resolveDataRoot({ CLADE_DATA_DIR: 'krolodex-data' }, ENGINE, ENGINE),
    /must be an absolute path/,
  )
})

test('~-prefixed CLADE_DATA_DIR → throws (Node never expands ~)', () => {
  // The killer case from the review: ~/Krolodex is not absolute to Node, so
  // tolerate-and-resolve would have produced <cwd>/~/Krolodex inside the repo.
  assert.throws(
    () => resolveDataRoot({ CLADE_DATA_DIR: '~/Krolodex' }, ENGINE, ENGINE),
    /must be an absolute path/,
  )
})

test('absolute CLADE_DATA_DIR INSIDE the engine repo → throws', () => {
  assert.throws(
    () =>
      resolveDataRoot(
        { CLADE_DATA_DIR: `${ENGINE}/contacts` },
        ENGINE,
        ENGINE,
      ),
    /inside the Clade engine repo/,
  )
})

test('the engine repo root itself as CLADE_DATA_DIR → throws', () => {
  assert.throws(
    () => resolveDataRoot({ CLADE_DATA_DIR: ENGINE }, ENGINE, ENGINE),
    /inside the Clade engine repo/,
  )
})

test('a sibling dir sharing the engine name prefix is NOT "inside" the repo', () => {
  // /...//clade-data must not be mistaken for a subdir of /...//clade.
  const { root } = resolveDataRoot(
    { CLADE_DATA_DIR: `${ENGINE}-data` },
    ENGINE,
    ENGINE,
  )
  assert.equal(root, `${ENGINE}-data`)
})

test('paths normalize (trailing slash / . segments) before the inside-repo check', () => {
  assert.throws(
    () =>
      resolveDataRoot(
        { CLADE_DATA_DIR: `${ENGINE}/../clade/contacts` },
        ENGINE,
        ENGINE,
      ),
    /inside the Clade engine repo/,
  )
})
