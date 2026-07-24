// pattern: Functional Core (resolveDataRoot) + a thin imperative boundary (dataRoot/dataPath)
// The ONE place CLADE_DATA_DIR is read. Every imperative shell resolves its data
// paths through dataPath() so a single Clade-cwd session can drive data ops
// against a private data directory that lives OUTSIDE this public repo's tree.
//
// LOAD-BEARING — data paths are cwd-relative by default ON PURPOSE. A private
// data instance (e.g. Krolodex) runs this engine against ITS OWN data two ways,
// both of which must keep the owner's real contacts out of this public repo:
//   1. cd <instance> && node <clade>/scripts/build-index.mjs        (cwd = instance)
//   2. CLADE_DATA_DIR=<instance> node <clade>/scripts/build-index.mjs (from anywhere)
// The default (CLADE_DATA_DIR unset) is process.cwd(), so form 1 is byte-for-byte
// unchanged. Do NOT anchor DATA paths to this script's own location
// (import.meta.url): that would redirect every instance build into THIS repo's
// contacts/ — a private-data-into-public leak.
//
// This module lives in scripts/ (NOT scripts/lib/) deliberately: the package
// `exports` map only publishes "./lib/*", so keeping this here means the one
// env/cwd-reading module is never exposed as instance-facing API — lib/ stays
// 100% data-as-args, and a symlinked consumer can't import path resolution that
// would silently run against ITS process env.
//
// NOTE the one legitimate use of import.meta.url below: engineRoot() uses it to
// locate the ENGINE repo (to REFUSE a data dir that sits inside the public tree).
// That is detecting "am I about to write into my own repo," NOT resolving data
// paths against the script location — the exact distinction the contract draws.

import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    // If cwd IS the engine repo itself, warn: that's the "operator forgot the
    // var while sitting in the public repo" footgun — a soft signal, not a
    // refusal (the engine's own dev/test runs legitimately have cwd = engine).
    const warn =
      resolve(cwd) === engine
        ? 'operating on the Clade engine repo itself — set CLADE_DATA_DIR to target your data dir'
        : null
    return { root: resolve(cwd), warn }
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
export function dataPath(...segments) {
  return join(dataRoot(), ...segments)
}
