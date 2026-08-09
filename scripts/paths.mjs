// pattern: Functional Core (resolveDataRoot) + a thin imperative boundary (dataRoot/dataPath)
// The ONE place CLADE_DATA_DIR is read. Every imperative shell resolves its data
// paths through dataPath() so a single Clade-cwd session can drive data ops
// against a private data directory that lives OUTSIDE this public repo's tree.
//
// LOAD-BEARING — data paths are cwd-relative by default ON PURPOSE. A private
// data instance runs this engine against ITS OWN data two ways,
// both of which must keep the owner's real contacts out of this public repo:
//   1. cd <instance> && node <clade>/scripts/build-index.mjs        (cwd = instance)
//   2. CLADE_DATA_DIR=<instance> node <clade>/scripts/build-index.mjs (from anywhere)
// The default (CLADE_DATA_DIR unset) is process.cwd(), so form 1 is byte-for-byte
// unchanged. Do NOT anchor DATA paths to this script's own location
// (import.meta.url): that would redirect every instance build into THIS repo's
// contacts/ — a private-data-into-public leak.
//
// This module lives in scripts/ (NOT scripts/lib/) deliberately: the package
// `exports` map only publishes "./lib/*", so keeping this here means data-path
// resolution is never exposed as instance-facing API, and a symlinked consumer
// can't import path resolution that would silently run against ITS process env.
// State the invariant narrowly, because the broad version is already false:
// lib/agent.mjs reads process.env for CLADE_AGENT_* by design. What holds is
// that NOTHING under lib/ reads CLADE_DATA_DIR or cwd, or resolves a data path
// — enforced by the lib scan in test/seam-totality.test.mjs, not by prose.
//
// NOTE the one legitimate use of import.meta.url below: engineRoot() uses it to
// locate the ENGINE repo (to REFUSE a data dir that sits inside the public tree).
// That is detecting "am I about to write into my own repo," NOT resolving data
// paths against the script location — the exact distinction the contract draws.

import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// The data top-level directories, in ONE place. The seam-totality guard regex,
// data-write.mjs's ALLOWED_ROOTS, and the .gitignore data block all encode this
// same set; when a fourth arrives, a whitelist that isn't derived from a shared
// constant fails OPEN — the guard silently stops being total while gitignore
// leaves the new dir trackable. Derive, don't re-type.
export const DATA_TOP_DIRS = ['contacts', 'imports', 'profile']

// Data files that must never be written as an opaque byte stream, and what to
// use instead. Lives here (beside DATA_TOP_DIRS, in the one file the
// seam-totality scan exempts) rather than in data-write.mjs, because these ARE
// data-path literals and the guard correctly refuses to see them anywhere else.
// Two classes:
//   - MERGE-PRESERVING: attest.mjs / record-merge.mjs upsert a single entry
//     under a lock. A wholesale overwrite bypasses the upsert and the envelope
//     validation — and the realistic route is mundane, since attest.mjs has no
//     delete operation and hand-editing is forbidden, so "remove a bad
//     attestation" becomes "regenerate the file", destroying every entry written
//     since the read. It reports success either way.
//   - GENERATED: rebuilt by build-index, so a hand-supplied version is discarded
//     on the next rebuild — the write silently does nothing durable.
export const UNWRITABLE_DATA_FILES = new Map([
  [`${DATA_TOP_DIRS[0]}/attested.json`, 'use scripts/attest.mjs (it upserts one entry under a lock)'],
  [`${DATA_TOP_DIRS[0]}/merge-decisions.json`, 'use scripts/record-merge.mjs'],
  [`${DATA_TOP_DIRS[0]}/unified-index.json`, 'generated — run scripts/build-index.mjs'],
  [`${DATA_TOP_DIRS[0]}/merge-candidates.json`, 'generated — run scripts/build-index.mjs'],
])

// paths.mjs lives at <engineRoot>/scripts/paths.mjs → engineRoot is one up.
function engineRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

// Pure: resolve the data root from an env bag + cwd + the engine root. Returns
// { root, warn }, or throws a loud error for the two unsafe cases. No filesystem
// or process access — unit-tested directly in test/paths.test.mjs.
export function resolveDataRoot(env, cwd, root) {
  const v = env.CLADE_DATA_DIR
  const engine = resolve(root)
  if (!v) {
    // Unset → cwd default. Preserves the direct-invocation contract exactly.
    // If cwd is the engine repo — OR ANY DIRECTORY UNDER IT — warn: that's the
    // "operator forgot the var while sitting in the public repo" footgun. A soft
    // signal, not a refusal (the engine's own dev/test runs legitimately have
    // cwd = engine).
    //
    // The subdirectory half is load-bearing and was missing: this test used to
    // be `=== engine`, while the env-var check below already used startsWith.
    // The gap is not cosmetic, because the .gitignore data patterns are
    // ROOT-anchored (`contacts/*`, not `**/contacts/*`) — so from cwd =
    // <engine>/scripts, a converter writes real contact PII to
    // scripts/contacts/normalized/*.json, which git does NOT ignore, with no
    // warning at all. Verified 2026-08-09 against git check-ignore.
    const cwdAbs = resolve(cwd)
    const inEngine = cwdAbs === engine || cwdAbs.startsWith(engine + sep)
    const warn = inEngine
      ? 'operating inside the Clade engine repo — set CLADE_DATA_DIR to target your data dir'
      : null
    return { root: cwdAbs, warn }
  }
  if (!isAbsolute(v)) {
    // Node never expands ~ or resolves relative paths the shell way, so a
    // relative value would silently land inside cwd (= the public repo in the
    // target workflow). Reject loudly rather than resolve into a leak.
    throw new Error(
      `CLADE_DATA_DIR must be an absolute path (got ${JSON.stringify(v)}). ` +
        'Node does not expand ~ or resolve relative paths like a shell; a ' +
        'relative value would silently resolve inside the current directory.',
    )
  }
  const dataRootAbs = resolve(v)
  if (dataRootAbs === engine || dataRootAbs.startsWith(engine + sep)) {
    // A data dir inside the public repo defeats the entire point and dodges the
    // root-anchored .gitignore. Never legitimate.
    throw new Error(
      `CLADE_DATA_DIR (${dataRootAbs}) is inside the Clade engine repo (${engine}). ` +
        'Your data directory must live outside the public repo tree.',
    )
  }
  return { root: dataRootAbs, warn: null }
}

let announced = false
function announce(msg) {
  if (announced) return
  announced = true
  process.stderr.write(`clade: ${msg}\n`)
}

// Imperative boundary: resolve against the live env/cwd, enforce existence when
// the var is set (a typo'd absolute path would otherwise silently spawn a fresh
// empty tree), and self-evidence the resolved root once per process on stderr.
export function dataRoot() {
  const { root, warn } = resolveDataRoot(process.env, process.cwd(), engineRoot())
  if (process.env.CLADE_DATA_DIR) {
    if (!existsSync(root)) {
      throw new Error(
        `CLADE_DATA_DIR does not exist: ${root} — create the data directory first ` +
          '(subdirectories like contacts/ are made automatically, the root is not).',
      )
    }
    if (!statSync(root).isDirectory()) {
      throw new Error(`CLADE_DATA_DIR is not a directory: ${root}`)
    }
    // The inside-the-engine refusal above it (in the pure resolver) compares
    // path STRINGS, because that function may not touch the filesystem. A
    // symlink living outside the repo whose TARGET is inside it therefore sails
    // through: every write then lands in the public tree through the link, and
    // an arbitrary directory name reached that way is not covered by the
    // root-anchored .gitignore either. Reproduced 2026-08-09 — a seeded
    // name+email reached `git status` as an untracked file, which is exactly the
    // observable ADR-06 names as its own falsifier. Only realpath can see it, so
    // the check is repeated here on real paths. The pure half stays fs-free.
    const realRoot = realpathSync(root)
    const realEngine = realpathSync(engineRoot())
    if (realRoot === realEngine || realRoot.startsWith(realEngine + sep)) {
      throw new Error(
        `CLADE_DATA_DIR (${root}) resolves to ${realRoot}, which is inside the Clade engine repo (${realEngine}). ` +
          'Your data directory must live outside the public repo tree — following symlinks.',
      )
    }
    announce(`data root: ${root} (CLADE_DATA_DIR)`)
  } else if (warn) {
    announce(`warning: ${warn}`)
  }
  return root
}

// Resolve a data path under the data root. Use for BUILT-IN DEFAULT paths only.
// NEVER wrap a user-supplied CLI path (argv, --flag values) in this: join() does
// not reset on an absolute segment the way resolve() does, so an absolute user
// path would be mangled (join('/data','/tmp/x') → '/data/tmp/x'), and a relative
// one would be silently re-anchored off the data root instead of the user's cwd.
// User paths keep normal CLI semantics (resolve against cwd) — pass them through
// untouched.
//
// The one sanctioned exception, so this NEVER doesn't read as absolute and get
// "fixed" by a future maintainer: a user-supplied path that names a PII-BEARING
// OUTPUT (cue-tag's --proposals, data-write's target) anchors its relative form
// to the data root rather than cwd, because cwd may be the public engine repo.
// Those call sites use dataPathContained() below, not dataPath() — a bare join
// normalizes '..' and so cannot enforce the containment they need. See ADR-06 §1.
export function dataPath(...segments) {
  return join(dataRoot(), ...segments)
}

// Resolve a USER-SUPPLIED relative path under the data root, REFUSING traversal.
// dataPath() cannot do this job: join() normalizes '..' segments, so
// dataPath('../x.json') silently resolves to the data root's parent, and a
// longer chain reaches anywhere writable on the disk. Both PII-bearing-output
// call sites route here so the check can't drift apart between them again.
// It also enforces UNWRITABLE_DATA_FILES, and that belongs HERE rather than at
// each caller: the first version of this guard lived only in data-write.mjs, and
// cue-tag's --proposals reached the same files through the same atomic-write
// primitive with no check at all — `--proposals contacts/attested.json --force`
// replaced the owner's attested facts with a proposals envelope and printed
// success. Protecting one call site and not its sibling is how a guard becomes
// decoration; every user-supplied output path resolves through this function.
export function dataPathContained(userPath) {
  const root = dataRoot()
  const abs = join(root, userPath)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing target outside the data root: ${userPath}`)
  }
  const posixRel = rel.split(sep).join('/')
  const refusal = UNWRITABLE_DATA_FILES.get(posixRel)
  if (refusal) {
    throw new Error(`Refusing to overwrite ${posixRel} wholesale — ${refusal}.`)
  }
  return abs
}
