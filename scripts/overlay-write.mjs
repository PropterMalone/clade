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
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

// Write via a sibling temp file + rename. rename(2) is atomic on the same
// filesystem, and the temp always sits beside the target, so it never crosses a
// device boundary. Readers see either the old file or the new one, never a
// half-written one, and a crash leaves the previous contents intact.
export function atomicWriteFileSync(target, content) {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, content)
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

// Returns true if it removed a lock whose owner is gone.
function reapIfStale(lock) {
  let pid
  try {
    pid = Number(readFileSync(lock, 'utf8').trim())
  } catch {
    return false // vanished between the EEXIST and here — just retry
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    try {
      unlinkSync(lock)
      return true
    } catch {
      return false
    }
  }
  try {
    process.kill(pid, 0) // signal 0 = existence probe, sends nothing
    return false // alive; wait for it
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
}

// Run fn() holding an exclusive lock on `target`. The whole read-modify-write
// must happen INSIDE fn — locking only the write would still lose updates,
// since the stale read is what makes the entry disappear.
export function withFileLock(target, fn, { attempts = 200, waitMs = 25 } = {}) {
  const lock = `${target}.lock`
  mkdirSync(dirname(target), { recursive: true })
  for (let i = 0; i < attempts; i++) {
    let fd
    try {
      fd = openSync(lock, 'wx') // O_CREAT|O_EXCL — atomic create-or-fail
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (!reapIfStale(lock)) sleepSync(waitMs)
      continue
    }
    try {
      writeSync(fd, String(process.pid))
      closeSync(fd)
      fd = undefined
      return fn()
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* already closed */
        }
      }
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
    const current = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : fallback
    const next = transform(current)
    atomicWriteFileSync(target, `${JSON.stringify(next, null, 2)}\n`)
    return next
  })
}
