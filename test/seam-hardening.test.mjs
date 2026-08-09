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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { atomicWriteFileSync, withFileLock } from '../scripts/overlay-write.mjs'

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

test('sustained contention loses no updates', async () => {
  // The one-shot test above cannot see a broken lock: ~50ms of node startup
  // jitter staggers the acquisitions, so the narrow window inside lock
  // ACQUISITION is almost never hit, and a lock that admits two holders still
  // passes it. (Measured: with the lock surgically removed, the 12-shot test
  // still went green about 1 run in 7.) This drives updateJsonFile in a loop
  // instead, which produces continuous contention and fails near-deterministically.
  const dir = freshDataDir()
  try {
    const target = join(dir, 'contacts/counter.json')
    const W = 6
    const C = 50
    const results = await Promise.all(
      Array.from({ length: W }, (_, i) =>
        new Promise((resolveP, rejectP) => {
          const p = spawn(node, [join(ROOT, 'test/lock-worker.mjs'), target, String(i), String(C)], {
            cwd: ROOT,
            env: { ...process.env, CLADE_DATA_DIR: dir },
          })
          let stderr = ''
          p.stderr.on('data', (d) => { stderr += d })
          p.on('error', rejectP)
          p.on('close', (code) => resolveP({ code, stderr }))
        }),
      ),
    )
    const failed = results.filter((r) => r.code !== 0)
    assert.equal(failed.length, 0, `workers should all succeed: ${failed.map((f) => f.stderr).join('; ')}`)
    const keys = Object.keys(JSON.parse(readFileSync(target, 'utf8')))
    assert.equal(keys.length, W * C, `every locked update must survive: lost ${W * C - keys.length} of ${W * C}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a lock held by a LIVE process is never stolen', () => {
  // The reaper briefly had an age-based fallback: a lock older than a cutoff was
  // taken regardless of whether its holder lived. Reproduced consequence — a
  // holder stalled inside its critical section (suspend, swap, SIGSTOP) lost its
  // lock, the contender wrote and exited 0, then the original holder finished and
  // wrote its stale snapshot over the top, erasing the contender's entry with
  // both processes reporting success. Waiting and failing loudly beats a silent
  // steal for data that cannot be regenerated.
  //
  // Honest limit: this pins "a live holder is never displaced" in general, NOT
  // the age-cutoff case specifically — catching that would need a test that
  // holds a lock past the old 60s threshold, which is too slow to keep in the
  // suite. The protection there is that the code path no longer exists.
  const dir = freshDataDir()
  try {
    const target = join(dir, 'contacts/attested.json')
    mkdirSync(dirname(target), { recursive: true })
    // This test process is unquestionably alive, so its pid is a live holder.
    writeFileSync(`${target}.lock`, String(process.pid))

    let ran = false
    assert.throws(
      () => withFileLock(target, () => { ran = true }, { attempts: 3, waitMs: 5 }),
      /Could not acquire/,
      'a live holder must be waited on, then reported — never displaced',
    )
    assert.equal(ran, false, 'the critical section must not run while another holder has the lock')
    assert.ok(existsSync(`${target}.lock`), "the live holder's lock must survive")

    // The stall must leave a durable trace. ADR-11's falsifier asks whether
    // choosing to stall rather than auto-recover ever costs an operator
    // anything, and the cost is paid HERE and then erased — the operator deletes
    // the lock and every after-the-fact sweep reads clean. Without this
    // assertion, a refactor of the throw path stops writing the breadcrumb, the
    // falsifier silently becomes unfalsifiable, and nothing goes red. That
    // failure has already shipped twice in this ADR's short life.
    const stalls = readFileSync(join(dir, 'contacts/.lock-stalls'), 'utf8')
    assert.match(stalls, /Could not acquire/)
    assert.match(stalls, new RegExp(`holder=${process.pid}\\b`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('overlay writes preserve a tightened file mode', () => {
  // A rename makes the temp file's mode the target's, so without explicit
  // preservation every save silently widened permissions: measured 600 -> 664
  // after a single attest, on a file holding the owner's whole address book.
  const dir = freshDataDir()
  try {
    run('scripts/attest.mjs', ['--key', 'manual:a', '--relationship', 'x'], dir)
    const target = join(dir, 'contacts/attested.json')
    chmodSync(target, 0o600)

    run('scripts/attest.mjs', ['--key', 'manual:b', '--relationship', 'y'], dir)
    assert.equal(statSync(target).mode & 0o777, 0o600, 'saving must not widen the file mode')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an overlay that parses but has the wrong shape is refused, not replaced', () => {
  // JSON.parse succeeding is not enough. The envelope helpers coerce a
  // parseable non-object (an array, a bare null) to empty, so the write-back
  // produced a fresh envelope holding ONLY the new entry — reproduced,
  // destroying every prior attestation while reporting success.
  const dir = freshDataDir()
  try {
    const target = join(dir, 'contacts/attested.json')
    mkdirSync(dirname(target), { recursive: true })
    for (const wrong of ['[{"a":1},{"b":2}]', 'null', '"a string"']) {
      writeFileSync(target, wrong)
      const r = run('scripts/attest.mjs', ['--key', 'manual:new', '--relationship', 'z'], dir)
      assert.notEqual(r.status, 0, `wrong-shape overlay must be refused: ${wrong}`)
      assert.match(r.stderr, /Refusing to rewrite/)
      assert.equal(readFileSync(target, 'utf8'), wrong, 'the damaged file must be left exactly as found')
      assert.ok(!existsSync(`${target}.lock`), 'no lock may be left behind')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a malformed overlay is refused and left byte-identical', () => {
  const dir = freshDataDir()
  try {
    const target = join(dir, 'contacts/attested.json')
    mkdirSync(dirname(target), { recursive: true })
    const damaged = '{"schemaVersion":1,"entries":{'
    writeFileSync(target, damaged)

    const r = run('scripts/attest.mjs', ['--key', 'manual:new', '--relationship', 'z'], dir)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /Malformed/)
    assert.equal(readFileSync(target, 'utf8'), damaged, 'a damaged overlay must never be "recovered" by overwriting it')
    assert.ok(!existsSync(`${target}.lock`), 'no lock may be left behind')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a lock left behind by a dead process is reaped', () => {
  // Without this, one crash mid-attest bricks every later overlay write: each
  // one waits out the full retry budget and then errors. Nothing covered the
  // reap path, so inverting its ESRCH check kept the suite green.
  const dir = freshDataDir()
  try {
    run('scripts/attest.mjs', ['--key', 'manual:first', '--relationship', 'x'], dir)
    const deadPid = spawnSync(node, ['-e', 'process.exit(0)']).pid
    writeFileSync(join(dir, 'contacts/attested.json.lock'), String(deadPid))

    const r = run('scripts/attest.mjs', ['--key', 'manual:second', '--relationship', 'y'], dir)
    assert.equal(r.status, 0, `a stale lock must be reaped, not waited out: ${r.stderr}`)
    const entries = JSON.parse(readFileSync(join(dir, 'contacts/attested.json'), 'utf8')).entries
    assert.ok(entries['manual:second'], 'the write should have gone through')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('atomicWriteFileSync replaces the file rather than truncating it in place', () => {
  // The discriminating observation: rename() swaps in a NEW inode, while a plain
  // writeFileSync truncates and rewrites the SAME one. Without this, the whole
  // primitive could be reverted to writeFileSync and all 277 tests still passed
  // — the "no temp files left behind" test is one-sided, since a plain write
  // leaves none either.
  const dir = freshDataDir()
  try {
    const target = join(dir, 'sample.json')
    atomicWriteFileSync(target, 'first\n')
    const before = statSync(target).ino
    atomicWriteFileSync(target, 'second\n')
    assert.notEqual(statSync(target).ino, before, 'the target must be replaced by rename, not rewritten in place')
    assert.equal(readFileSync(target, 'utf8'), 'second\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no shell calls a bare writeFileSync on a data path', () => {
  // Pins the CALL SITES, complementing the inode check above which pins the
  // primitive. Either half can regress independently.
  //
  // ENUMERATED, not listed. The first version of this test hardcoded six file
  // paths — which is the per-call-site guard this project keeps getting bitten
  // by, wearing a chokepoint's description: a seventh script writing an overlay
  // would have been invisible until someone remembered to add it. Scanning every
  // shell means a new one is covered the day it lands.
  //
  // A write that genuinely isn't overlay data marks itself with `not-data:` and
  // says why. That keeps the escape hatch explicit and greppable rather than
  // implicit in a list nobody re-reads.
  const shells = [
    ...readdirSync(join(ROOT, 'scripts'))
      .filter((f) => f.endsWith('.mjs') && f !== 'overlay-write.mjs') // defines the primitive
      .map((f) => `scripts/${f}`),
    'search.mjs',
  ]
  const violations = []
  for (const f of shells) {
    readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      if (line.trimStart().startsWith('//')) return
      if (!/\bwriteFileSync\(/.test(line)) return
      if (/\batomicWriteFileSync\(/.test(line)) return
      if (/not-data:/.test(line)) return
      violations.push(`${f}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(
    violations,
    [],
    `these must write through atomicWriteFileSync (or mark themselves \`not-data:\`):\n${violations.join('\n')}`,
  )
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

    // BOTH path forms. The guard first shipped on the relative branch only,
    // while `if (isAbsolute(v)) return v` sat one line above it and skipped the
    // check entirely — the same miss, one line higher, found by the next review.
    for (const form of ['contacts/attested.json', attested]) {
      const r = run('scripts/cue-tag.mjs', ['--proposals', form, '--cue', 'x', '--tag', 'y', '--force'], dir)
      assert.notEqual(r.status, 0, `pointing --proposals at a managed overlay must be refused (${form})`)
      // Assert on the REASON, not just the exit code: cue-tag has several other
      // ways to exit nonzero (no index, no cue), any of which would let this
      // test pass while the guard was gone.
      assert.match(r.stderr, /Refusing to overwrite attested\.json wholesale/)
      assert.equal(readFileSync(attested, 'utf8'), before, `the attested overlay must be untouched (${form})`)
    }
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
