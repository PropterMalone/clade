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
  const { root, warn } = resolveDataRoot({}, '/home/user/private-data', ENGINE)
  assert.equal(root, '/home/user/private-data')
  assert.equal(warn, null)
})

test('unset + cwd IS the engine repo → returns cwd but warns', () => {
  const { root, warn } = resolveDataRoot({}, ENGINE, ENGINE)
  assert.equal(root, ENGINE)
  assert.match(warn, /inside the Clade engine repo/)
})

test('unset + cwd is a SUBDIRECTORY of the engine repo → also warns', () => {
  // This warned only on exact equality, while the env-var branch below already
  // used startsWith. The gap had teeth: the .gitignore data patterns are
  // root-anchored (`contacts/*`, not `**/contacts/*`), so from cwd =
  // <engine>/scripts a converter writes real contact PII to
  // scripts/contacts/normalized/*.json — a path git does NOT ignore — with no
  // signal at all. Verified against git check-ignore, 2026-08-09.
  const { root, warn } = resolveDataRoot({}, `${ENGINE}/scripts`, ENGINE)
  assert.equal(root, `${ENGINE}/scripts`)
  assert.match(warn, /inside the Clade engine repo/)
})

test('unset + cwd is a SIBLING sharing the engine name prefix → no warning', () => {
  // /…/clade-data must not be mistaken for a directory inside /…/clade.
  const { warn } = resolveDataRoot({}, `${ENGINE}-data`, ENGINE)
  assert.equal(warn, null)
})

test('absolute CLADE_DATA_DIR outside the repo → that path, no warning', () => {
  const { root, warn } = resolveDataRoot(
    { CLADE_DATA_DIR: '/home/user/private-data' },
    ENGINE,
    ENGINE,
  )
  assert.equal(root, '/home/user/private-data')
  assert.equal(warn, null)
})

test('relative CLADE_DATA_DIR → throws (would resolve inside cwd)', () => {
  assert.throws(
    () => resolveDataRoot({ CLADE_DATA_DIR: 'krolodex-data' }, ENGINE, ENGINE),
    /must be an absolute path/,
  )
})

test('~-prefixed CLADE_DATA_DIR → throws (Node never expands ~)', () => {
  // The killer case from the review: ~/private-data is not absolute to Node, so
  // tolerate-and-resolve would have produced <cwd>/~/private-data inside the repo.
  assert.throws(
    () => resolveDataRoot({ CLADE_DATA_DIR: '~/private-data' }, ENGINE, ENGINE),
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
