// pattern: functional-core
// Hardening spec for the CLADE_DATA_DIR seam's IMPERATIVE half — the guarantees
// the pure resolver (test/paths.test.mjs) structurally cannot make, because each
// one depends on the filesystem or on two processes running at once.
//
// Every test here corresponds to a shipped behavior that was asserted in prose
// and unenforced in code (review 2026-08-09):
//   1. "CLADE_DATA_DIR must live outside the engine repo"  — held for path
//      strings, bypassed by a symlink, which is how owner PII reached an
//      untracked file in the public repo.
//   2. "the overlay helpers are the safe way to write"      — held for WHERE the
//      write lands, not for whether a concurrent sibling's write survives.
//   3. "a relative --proposals must land in the DATA dir"   — join() normalizes
//      '..', so it did not.
//   4. data-write.mjs is the escape hatch for unstructured writes — it also
//      accepted wholesale overwrites of the merge-preserving overlays.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath

// A data dir that is NOT inside the engine repo, for the tests that need a valid one.
const freshDataDir = () => mkdtempSync(join(tmpdir(), 'clade-hardening-'))

// Spawn a shell with the env fully under test control. Inheriting the ambient
// CLADE_DATA_DIR would point these at the operator's REAL address book.
function run(script, args, dataDir, input) {
  return spawnSync(node, [join(ROOT, script), ...args], {
    cwd: ROOT,
    env: { ...process.env, CLADE_DATA_DIR: dataDir },
    encoding: 'utf8',
    input,
  })
}

test('CLADE_DATA_DIR symlinked INTO the engine repo throws (realpath, not string prefix)', () => {
  // The string guard compares resolve()d paths and never touches the filesystem,
  // so a link living outside the repo whose TARGET is inside it sailed through.
  // Linking to the engine root itself proves the bypass without creating
  // anything inside the repo.
  const dir = freshDataDir()
  try {
    const link = join(dir, 'looks-outside')
    symlinkSync(ROOT, link)
    const r = run('scripts/build-index.mjs', [], link)
    assert.notEqual(r.status, 0, 'a data root resolving inside the engine repo must be refused')
    assert.match(r.stderr, /inside the Clade engine repo/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent attest.mjs calls all survive (no lost update)', async () => {
  // Reproduced before the fix: 20 parallel calls, all exit 0 and print
  // "Attested", 19 entries present. Both processes read version V and each
  // wrote its own V+1. The success message measured "file written", not
  // "entry present" — so the owner's irreplaceable fact vanished silently.
  //
  // This MUST use async spawn: spawnSync runs each child to completion before
  // starting the next, so a "parallel" loop built on it is serial and passes
  // against the very bug it is meant to catch.
  const dir = freshDataDir()
  try {
    const N = 12
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        new Promise((resolveP, rejectP) => {
          const p = spawn(node, [
            join(ROOT, 'scripts/attest.mjs'),
            '--key', `manual:person-${i}`,
            '--relationship', `rel-${i}`,
          ], { cwd: ROOT, env: { ...process.env, CLADE_DATA_DIR: dir } })
          let stderr = ''
          p.stderr.on('data', (d) => { stderr += d })
          p.on('error', rejectP)
          p.on('close', (code) => resolveP({ code, stderr }))
        }),
      ),
    )
    const failed = results.filter((r) => r.code !== 0)
    assert.equal(failed.length, 0, `all calls should succeed: ${failed.map((f) => f.stderr).join('; ')}`)

    const file = join(dir, 'contacts/attested.json')
    const entries = JSON.parse(readFileSync(file, 'utf8')).entries
    assert.equal(
      Object.keys(entries).length,
      N,
      'every attestation must survive — a lost entry here is an owner fact gone with no symptom',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attest.mjs works against a fresh data dir (creates contacts/)', () => {
  // dataRoot()'s own error text promises "subdirectories like contacts/ are made
  // automatically" — attest.mjs and record-merge.mjs did not, and died on ENOENT.
  const dir = freshDataDir()
  try {
    const r = run('scripts/attest.mjs', ['--key', 'manual:x', '--relationship', 'cousin'], dir)
    assert.equal(r.status, 0, `expected success, got: ${r.stderr}`)
    assert.ok(existsSync(join(dir, 'contacts/attested.json')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('record-merge.mjs works against a fresh data dir', () => {
  const dir = freshDataDir()
  try {
    const r = run('scripts/record-merge.mjs', ['--keys', 'a:1,b:2', '--verdict', 'same'], dir)
    assert.equal(r.status, 0, `expected success, got: ${r.stderr}`)
    assert.ok(existsSync(join(dir, 'contacts/merge-decisions.json')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cue-tag --proposals refuses a traversal escape from the data root', () => {
  // dataPath() is join(), which normalizes '..' — so the value the comment said
  // "must land in the DATA dir" could land in the engine repo, or anywhere.
  const dir = freshDataDir()
  try {
    const r = run('scripts/cue-tag.mjs', ['--proposals', '../escaped.json', '--cue', 'x', '--tag', 'y'], dir)
    assert.notEqual(r.status, 0, 'a traversing --proposals must be refused')
    assert.match(r.stderr, /outside the data root/)
    assert.ok(!existsSync(join(dirname(dir), 'escaped.json')), 'nothing may be written outside the root')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cue-tag --proposals refuses the helper-managed and generated files too', () => {
  // The first version of this guard lived only in data-write.mjs. cue-tag's
  // --proposals reached the same files through the same atomic-write primitive
  // with no check: `--proposals contacts/attested.json --force` replaced the
  // owner's attested facts with a proposals envelope and reported success.
  // Protecting one call site and not its sibling is how a guard becomes
  // decoration, so the refusal now lives in the shared resolver.
  const dir = freshDataDir()
  try {
    const attested = join(dir, 'contacts/attested.json')
    run('scripts/attest.mjs', ['--key', 'manual:precious', '--relationship', 'irreplaceable'], dir)
    const before = readFileSync(attested, 'utf8')

    const r = run('scripts/cue-tag.mjs', ['--proposals', 'contacts/attested.json', '--cue', 'x', '--tag', 'y', '--force'], dir)
    assert.notEqual(r.status, 0, 'pointing --proposals at a managed overlay must be refused')
    // Assert on the REASON, not just the exit code: cue-tag has several other
    // ways to exit nonzero (no index, no cue), any of which would let this test
    // pass while the guard was gone.
    assert.match(r.stderr, /Refusing to overwrite contacts\/attested\.json wholesale/)
    assert.equal(readFileSync(attested, 'utf8'), before, 'the attested overlay must be untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('data-write.mjs refuses the helper-managed and generated files', () => {
  // It is the escape hatch for about-me.md / manual.json / enrichment batches.
  // A wholesale byte-stream overwrite of attested.json bypasses attest.mjs's
  // upsert, and a regeneration from a stale read destroys every entry since.
  const dir = freshDataDir()
  try {
    for (const target of [
      'contacts/attested.json',
      'contacts/merge-decisions.json',
      'contacts/unified-index.json',
      'contacts/merge-candidates.json',
    ]) {
      const r = run('scripts/data-write.mjs', [target], dir, '{"clobbered":true}')
      assert.notEqual(r.status, 0, `${target} must be refused`)
      assert.ok(!existsSync(join(dir, target)), `${target} must not be written`)
    }
    // The sanctioned targets still work.
    const ok = run('scripts/data-write.mjs', ['profile/about-me.md'], dir, '# hi\n')
    assert.equal(ok.status, 0, `about-me.md should still be writable: ${ok.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('overlay writes leave no temp files behind', () => {
  const dir = freshDataDir()
  try {
    run('scripts/attest.mjs', ['--key', 'manual:y', '--relationship', 'friend'], dir)
    const stray = readdirSync(join(dir, 'contacts')).filter((f) => f.includes('.tmp'))
    assert.deepEqual(stray, [], 'atomic write must rename, not leave a tmp file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the test suite is hermetic: an ambient CLADE_DATA_DIR does not reach it', () => {
  // Shells freeze dataPath() into module-scope consts, so IMPORTING one resolves
  // the data root. With the operator's real CLADE_DATA_DIR exported (the
  // documented private-instance workflow), the suite read their real data dir;
  // with a bad one, six tests failed at import, nowhere near the code under test.
  assert.equal(process.env.CLADE_DATA_DIR ?? '', '', 'test runner must neutralize CLADE_DATA_DIR')
})
