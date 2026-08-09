// pattern: imperative-shell
// Durable-write primitives for the overlay files — the owner's irreplaceable
// facts (attested relationships, merge rulings). Two failures motivated this,
// both reproduced 2026-08-09:
//
// 1. LOST UPDATE. attest.mjs / record-merge.mjs / cue-tag --apply each did an
//    unguarded read-modify-write of one shared file. Twenty parallel attest
//    calls, run twice: one run left nineteen entries (a clean lost update), the
//    other interleaved into invalid JSON and the next readers died in a cascade.
//    All twenty exited 0 and printed "Attested" both times — cite the range, not
//    either endpoint. Both processes read version V and each wrote V+1. This is
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
  appendFileSync,
  closeSync,
  existsSync,
  fchmodSync,
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
import { dirname, join } from 'node:path'


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
      // A rename makes the TEMP file's mode the target's mode, so without this
      // every write silently reverts a tightened permission: measured, an
      // attested.json chmod'd to 600 came back 664 after one attest. The old
      // truncate-in-place preserved it. These files hold the owner's whole
      // address book, so widening them as a side effect of saving is the wrong
      // direction to fail in.
      if (existsSync(target)) fchmodSync(fd, statSync(target).mode & 0o7777)
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
    return false // alive — wait for it, never steal
  } catch (err) {
    // ESRCH: the holder is gone. EPERM: it exists under another user — alive.
    if (err.code !== 'ESRCH') return false
  }

  // The holder is confirmed dead. Claim the reap by RENAMING the lock aside
  // rather than unlinking it: rename is atomic, so if two contenders both decide
  // "stale" at once exactly one succeeds and the loser gets ENOENT. Unlinking by
  // name instead lets the slower reaper delete a lock a third process has
  // already acquired in the meantime.
  const claim = `${lock}.reap-${process.pid}`
  try {
    renameSync(lock, claim)
  } catch {
    return false // someone else reaped or re-acquired it — just retry
  }
  // Re-read what we actually claimed. The rename above moves whatever is at
  // `lock` RIGHT NOW, which is not necessarily the dead pid that was read a few
  // lines up — a live holder may have acquired in between. If so, put it back.
  //
  // The putback is CREATE-ONLY (link, not rename) on purpose. An unconditional
  // rename here overwrites whatever occupies the path, and during the vacancy
  // this function opens between the steal and the putback, a third process can
  // legitimately acquire — so an unconditional putback silently destroys that
  // process's lock while it is inside its critical section. Reproduced 5/5 with
  // instrumented scheduling. If the path is occupied when we try to give it
  // back, the occupant is the rightful holder: drop the claim and let it stand.
  try {
    if (readFileSync(claim, 'utf8').trim() !== raw) {
      try {
        linkSync(claim, lock)
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
        // Someone else holds it now — theirs wins, ours is discarded below.
      }
      try {
        unlinkSync(claim)
      } catch {
        /* already gone */
      }
      return false
    }
  } catch {
    /* unreadable — fall through and drop it */
  }
  try {
    unlinkSync(claim)
  } catch {
    /* already gone */
  }
  return true
}

// NOTE ON WHAT IS DELIBERATELY ABSENT: an age-based "this lock looks too old,
// take it" fallback. It was here briefly, to cover the case where a crashed
// holder's pid gets recycled by an unrelated process and the lock therefore
// looks alive forever. It introduced a WORSE failure than the one it solved,
// reproduced: a live holder stalled inside its critical section (suspend, swap,
// SIGSTOP) had its lock reaped at the age cutoff; the contender wrote and exited
// 0; then the original holder finished and wrote its stale snapshot over the
// top, erasing the contender's entry — both processes reporting success.
// Pid reuse strands the operator with a loud, self-describing error telling them
// to delete the file. Silent loss of an owner-attested fact has no such recovery.
// Do not reintroduce a time-based steal for data that cannot be regenerated.

// Create the lock file WITH its pid already in it, atomically. Writing the
// content to a private staging name and hard-linking it into place means the
// lock never exists in a half-initialized state for a contender to misread.
// link(2) fails with EEXIST if the target exists, giving the same
// create-or-fail guarantee as O_EXCL.
// Release only a lock we still own. Unlinking by name unconditionally means a
// holder whose lock was taken from it goes on to delete the NEW holder's lock,
// admitting a third writer — the same shape as the lost-update bug this module
// exists to prevent, one layer up.
function release(lock) {
  try {
    if (readFileSync(lock, 'utf8').trim() !== String(process.pid)) return
  } catch {
    return // already gone
  }
  try {
    unlinkSync(lock)
  } catch {
    /* already released */
  }
}

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
      release(lock)
    }
  }
  // Name the pid. The whole module refuses to let CODE guess that a lock is safe
  // to take — so handing the operator "remove it and retry" with nothing to check
  // just relocates the same unverified guess to a human, who has every incentive
  // to delete and move on. Give them the one fact that settles it.
  let holder = 'unknown'
  try {
    holder = readFileSync(lock, 'utf8').trim() || 'empty'
  } catch {
    /* vanished while we were giving up — retrying will now succeed */
  }
  // Leave a durable breadcrumb BEFORE throwing. ADR-11 chooses to stall rather
  // than auto-recover, and its falsifier is "does that stall actually cost
  // operators anything" — but the cost is paid at this exact moment and then
  // erased: the operator deletes the lock and every after-the-fact sweep reads
  // clean. Without this line the falsifier is unfalsifiable, which is the whole
  // failure mode ADR-11's own lesson note warns about. Append-only, so it needs
  // no lock of its own; inside the data dir, so it never leaves custody.
  try {
    appendFileSync(
      join(dirname(target), '.lock-stalls'),
      `${new Date().toISOString()}\tCould not acquire\t${lock}\tholder=${holder}\n`,
    )
  } catch {
    /* best-effort telemetry — never let it mask the real error */
  }
  throw new Error(
    `Could not acquire ${lock} after ${attempts} attempts (held by pid ${holder}).\n` +
      `Check whether that process is alive: ps -p ${holder}\n` +
      `If it is alive, it is mid-write — wait, do not delete the lock.\n` +
      `If nothing is found, the holder died and its pid was reused; delete ${lock} and retry.`,
  )
}

// Convenience for the overlay writers: lock, read+transform, write atomically.
export function updateJsonFile(target, transform, fallback, { validate } = {}) {
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
      // Parsing is not enough. A file that parses to the WRONG SHAPE (an array
      // where an entry map belongs, a bare null) was coerced to empty by the
      // envelope helpers and then written back as a fresh envelope holding only
      // the new entry — reproduced, destroying every prior attestation while
      // reporting success. That is precisely the "silently replace a
      // damaged-but-repairable overlay" this refusal exists to prevent, so the
      // shape check has to sit beside the parse check.
      const problem = validate?.(current)
      if (problem) {
        throw new Error(`Refusing to rewrite ${target}: ${problem} The file was NOT modified.`)
      }
    }
    const next = transform(current)
    atomicWriteFileSync(target, `${JSON.stringify(next, null, 2)}\n`)
    return next
  })
}

// Shape guards for the two overlay families. Passed to updateJsonFile so a
// parseable-but-wrong-shape file is refused instead of silently replaced.
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

export const expectEntryMap = (v) =>
  isPlainObject(v) ? null : `expected a JSON object of entries (or a { schemaVersion, entries } envelope), got ${Array.isArray(v) ? 'an array' : typeof v}.`

export const expectDecisions = (v) =>
  Array.isArray(v) || isPlainObject(v) ? null : `expected an array of rulings (or a { schemaVersion, decisions } envelope), got ${typeof v}.`
