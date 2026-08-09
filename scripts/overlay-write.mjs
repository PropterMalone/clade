// pattern: imperative-shell
// Durable-write primitives for the overlay files — the owner's irreplaceable
// facts (attested relationships, merge rulings). Two failures motivated this,
// both reproduced 2026-08-09:
//
// 1. LOST UPDATE. attest.mjs / record-merge.mjs / cue-tag --apply each did an
//    unguarded read-modify-write of one shared file. Twenty parallel attest
//    calls: all twenty exited 0 and printed "Attested", nineteen entries
//    survived. Both processes read version V and each wrote its own V+1. This is
//    not a contrived race — the documented pipeline invites it (bulk merge
//    rulings, ~10 attestations per triage batch), and an operating agent under
//    normal parallel-tool-call doctrine fires per-key calls concurrently because
//    they LOOK independent: different --key, same file. The success message
//    measured the mechanic (a file was written), not the effect (the entry is
//    present), so the loss is permanent AND silent.
//
// 2. TRUNCATE-THEN-WRITE. writeFileSync opens with O_TRUNC, so a crash between
//    truncate and completion destroys the whole prior file, not just the new
//    entry. Same mechanism gives a torn read: the MCP server re-reads the index
//    on every call by design and can catch a rebuild mid-write.
//
// enrich-batch already took a data-root lock and pid-suffixed its bank files;
// the overlay writers got neither. Regenerable outputs don't need the lock, but
// they do want the atomic write.

import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

// A held lock older than this is treated as abandoned. Critical sections here
// are single-digit milliseconds, so a minute is far beyond any legitimate hold
// and still short enough that a crash doesn't strand the operator.
const STALE_LOCK_MS = 60_000

// Write via a sibling temp file + rename. rename(2) is atomic on the same
// filesystem, and the temp always sits beside the target, so it never crosses a
// device boundary. Readers see either the old file or the new one, never a
// half-written one, and a crash leaves the previous contents intact.
export function atomicWriteFileSync(target, content) {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}`
  try {
    // fsync before the rename. Without it the rename can reach the disk before
    // the temp file's own data blocks do, so a power loss leaves a valid
    // directory entry pointing at a short or empty file — the exact loss this
    // primitive exists to prevent, just at a lower layer. Cheap here: these
    // files are kilobytes and written once per operation.
    const fd = openSync(tmp, 'w')
    try {
      writeFileSync(fd, content)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, target)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* nothing to clean up */
    }
    throw err
  }
}

// Sync sleep with no dependencies and no busy-wait.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// A lock is only stale if its owner is gone. Getting this wrong in the
// permissive direction is worse than not locking at all, because it looks like
// mutual exclusion while providing none.
//
// Returns true if it removed a lock whose owner is gone.
function reapIfStale(lock) {
  let raw
  try {
    raw = readFileSync(lock, 'utf8').trim()
  } catch {
    return false // vanished between the EEXIST and here — just retry
  }

  // An unreadable or empty lock means WAIT, never reap. The first version
  // reaped it, and that single branch made the whole lock decorative: an
  // O_CREAT|O_EXCL open leaves the file empty for the microseconds before the
  // pid is written, so a contender that lost the open race read '', evaluated
  // Number('') === 0, matched the "garbage" case, and deleted a LIVE lock — then
  // both processes ran the critical section, and the loser's release deleted the
  // winner's lock, admitting a third. Measured: 20 of 300 updates lost.
  // acquire() below now writes the pid before the lock exists at all, so an
  // empty lock should be unreachable; this stays as the belt to that suspenders,
  // because the failure it guards is silent.
  const pid = Number(raw)
  if (!raw || !Number.isFinite(pid) || pid <= 0) return false

  try {
    process.kill(pid, 0) // signal 0 = existence probe, sends nothing
  } catch (err) {
    // ESRCH: the holder is gone. EPERM: it exists under another user — alive.
    if (err.code !== 'ESRCH') return false
    try {
      unlinkSync(lock)
      return true
    } catch {
      return false
    }
  }

  // The pid resolves to a LIVE process — but pids get recycled, so after a hard
  // crash an unrelated process can inherit the dead holder's number and keep the
  // lock alive forever. Critical sections here are single-digit milliseconds, so
  // treat a lock older than a minute as abandoned regardless of who holds the pid.
  try {
    if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
      unlinkSync(lock)
      return true
    }
  } catch {
    /* raced with another reaper — retry */
  }
  return false
}

// Create the lock file WITH its pid already in it, atomically. Writing the
// content to a private staging name and hard-linking it into place means the
// lock never exists in a half-initialized state for a contender to misread.
// link(2) fails with EEXIST if the target exists, giving the same
// create-or-fail guarantee as O_EXCL.
function acquire(lock) {
  const stage = `${lock}.stage-${process.pid}`
  try {
    writeFileSync(stage, String(process.pid))
    try {
      linkSync(stage, lock)
      return true
    } catch (err) {
      if (err.code === 'EEXIST') return false
      throw err
    }
  } finally {
    try {
      unlinkSync(stage)
    } catch {
      /* already gone */
    }
  }
}

// Run fn() holding an exclusive lock on `target`. The whole read-modify-write
// must happen INSIDE fn — locking only the write would still lose updates,
// since the stale read is what makes the entry disappear.
// The budget (attempts × waitMs) is a LOAD tolerance, not a correctness knob:
// critical sections here are single-digit milliseconds, so the only thing that
// consumes it is many writers plus a busy machine. 5s proved too tight — a run
// competing with several other node processes exhausted it and failed loudly.
// 15s is still far past "something is genuinely wrong" while surviving a spike.
export function withFileLock(target, fn, { attempts = 600, waitMs = 25 } = {}) {
  const lock = `${target}.lock`
  mkdirSync(dirname(target), { recursive: true })
  for (let i = 0; i < attempts; i++) {
    if (!acquire(lock)) {
      if (!reapIfStale(lock)) sleepSync(waitMs)
      continue
    }
    try {
      return fn()
    } finally {
      try {
        unlinkSync(lock)
      } catch {
        /* already released */
      }
    }
  }
  throw new Error(
    `Could not acquire ${lock} after ${attempts} attempts. ` +
      `If no other Clade process is running, remove it and retry.`,
  )
}

// Convenience for the overlay writers: lock, read+transform, write atomically.
export function updateJsonFile(target, transform, fallback) {
  return withFileLock(target, () => {
    let current = fallback
    if (existsSync(target)) {
      try {
        current = JSON.parse(readFileSync(target, 'utf8'))
      } catch (err) {
        // Refuse rather than "recover" by starting from the fallback: that would
        // silently replace a damaged-but-repairable overlay with an empty one.
        // Reword the bare SyntaxError so every CLI on this path reports the
        // problem the way cue-tag --apply already does.
        throw new Error(`Malformed ${target}: ${err.message} — fix it before retrying. The file was NOT modified.`)
      }
    }
    const next = transform(current)
    atomicWriteFileSync(target, `${JSON.stringify(next, null, 2)}\n`)
    return next
  })
}
