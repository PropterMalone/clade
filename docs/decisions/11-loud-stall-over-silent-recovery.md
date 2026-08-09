---
id: 11-loud-stall-over-silent-recovery
name: Loud stall over silent recovery for irreplaceable overlays
date: 2026-08-09
status: active
amends: null
supersedes: null
commits: [69e89c7, b8515e8, 935126b, 4c596d1, be24e30]
---

# Loud stall over silent recovery for irreplaceable overlays

**Decision**: Writes to the **non-regenerable** overlays — `contacts/attested.json`
and `contacts/merge-decisions.json`, the facts the owner supplied and that exist
nowhere else — go through `scripts/overlay-write.mjs`, which holds these three
properties, in this order of priority:

1. **Never displace a holder it cannot prove dead.** The lock is reaped only
   after a liveness probe on the recorded pid returns ESRCH. There is no
   timeout, no age cutoff, no "this looks abandoned" heuristic. When the lock
   cannot be taken, the writer **stops with a self-describing error** naming the
   file to delete — it does not proceed, and it does not recover automatically.
2. **The whole read-modify-write happens inside the lock.** Locking only the
   write still loses data: it is the stale *read* that makes a sibling's entry
   disappear.
3. **Replace, never truncate.** `atomicWriteFileSync` writes a sibling temp,
   `fsync`s it, inherits the target's mode, and renames over it. A reader sees
   the old file or the new one, never a partial one, and a crash leaves the
   previous contents intact.

A file that parses but has the **wrong shape** (an array where an entry map
belongs, a bare `null`) is refused with the file left byte-identical — the
envelope helpers coerce such input to empty, and writing that back produces a
fresh envelope holding only the newest entry.

Regenerable outputs (`unified-index.json`, `merge-candidates.json`,
`rolodex-knowledge.md`) take the atomic write but **not** the lock: they have a
single writer, and the atomicity is there for concurrent *readers* — the MCP
server re-reads the index on every tool call by design.

**Why**: Three review rounds on 2026-08-09, each finding real defects in the
previous round's fixes, converged on one principle. The measurements:

- **Unguarded read-modify-write loses owner facts silently.** 20 parallel
  `attest.mjs` calls did not merely drop an entry — they interleaved into
  *invalid JSON*, and the processes that read it next died in a cascade. Every
  process exited 0 and printed "Attested". The success message measured the
  mechanic (a file was written), not the effect (the entry is present).
- **The trigger is normal operation, not an exotic race.** The documented
  pipeline offers bulk merge rulings ("47 exact-name pairs — merge them all?")
  and ~10-attestation triage batches, and an operating agent under ordinary
  parallel-tool-call doctrine fires per-key calls concurrently *because they look
  independent*: different `--key`, same file. This subsystem's footgun points
  directly at how the tool is meant to be driven.
- **A lock that is 99% right is worse than none.** The first implementation
  created the lock file with `O_CREAT|O_EXCL` and wrote the pid microseconds
  later. A contender that lost the open race read `''`, evaluated
  `Number('') === 0`, matched a `pid <= 0` "garbage" branch, and deleted a **live**
  lock. 20 of 300 locked updates lost — while the test suite stayed green,
  because spawning one-shot CLIs staggers acquisition by ~50ms of node startup
  and never opens the window. Acquisition now writes the pid into a private
  staging file and `link(2)`s it into place, so the lock never exists
  half-initialized.

The ordering in the decision is the point. Property 1 outranks convenience
because of what these two files are: a lost merge ruling resurfaces as a re-asked
candidate at the next rebuild, but a lost attestation is the owner's
irreplaceable fact gone with **no symptom, ever**. Against that, an operator who
must delete a lock file has lost ten seconds and knows exactly what happened.

**Rejected alternative**: *Age-based staleness* — treat a lock held longer than
some cutoff as abandoned and take it. This was not merely considered; it was
**built and shipped** (commit 935126b, 60s cutoff) to cure a real problem: after a
hard crash, the dead holder's pid can be recycled by an unrelated process, so the
liveness probe reports "alive" and the lock is never reaped. It was removed one
commit later (4c596d1) because it converted a **loud** failure into a **silent**
one, reproduced: a live holder stalled inside its critical section (suspend,
swap, SIGSTOP) had its lock taken at the cutoff; the contender wrote and exited
0; then the original holder finished and wrote its stale snapshot over the top,
erasing the contender's entry — both processes reporting success. Pid reuse
strands the operator with an error telling them what to delete. There is no
equivalent recovery from an erased attestation. **Do not reintroduce a
time-based steal for data that cannot be regenerated**; the comment saying so
lives in `overlay-write.mjs` beside the code it warns about.

**Could-be-wrong-if**: refusing automatic recovery imposes real cost in practice —
i.e. the pid-reuse case this deliberately does not handle actually strands
operators. Observable as **a `.lock` file surviving in a live data directory long
after any writer could still hold it**, requiring manual deletion. Critical
sections here are single-digit milliseconds, so anything older than five minutes
is stranded, not busy. Threshold: **one or more** such files observed in ordinary
operation (not induced by a test) means the no-heuristic stance is costing more
than it saves, and the answer is a *safe* recovery — serializing reapers behind
their own lock and re-reading under that exclusion — not a return to the age
cutoff.

**Evaluated by**: `find "$CLADE_DATA_DIR/contacts" -maxdepth 1 -name '*.lock' -mmin +5 | wc -l`
→ `0` when the falsifier has NOT fired.

**Status quo check**: run against the live instance on the day this shipped →
`0`. The threshold is not decorative: planting a 20-minute-old lock file in a
scratch data dir and running the same command returns `1`. And it discriminates
the *right* case — a stranded lock holding a genuinely **dead** pid is reaped
automatically on the next write (verified: planted, then `attest.mjs` succeeded
and the lock count returned to `0`), so a surviving lock specifically indicates
pid reuse, which is exactly the scenario this ADR declines to auto-handle.

**How to apply**:

- **Any new writer of `attested.json` or `merge-decisions.json`** goes through
  `updateJsonFile`, with a shape validator (`expectEntryMap` / `expectDecisions`).
  Do the whole read-modify-write inside the callback; never read outside it and
  write inside.
- **Any new writer of a generated data file** uses `atomicWriteFileSync`. A bare
  `writeFileSync` on a data path is a regression, and
  `test/seam-hardening.test.mjs` scans for exactly that.
- **When a fix trades a loud failure for a silent one, it is a regression** even
  if it closes the original hole. That is the general form of the rejected
  alternative, and it applies past this subsystem: prefer stopping with a
  self-describing error over any automatic recovery that can guess wrong about
  data the owner cannot reproduce.
- **Guards belong at a chokepoint, not at each call site.** The sibling rule that
  every user-supplied write path resolves through one function
  (`dataPathContained` / `assertWritableTarget`) exists because the same
  managed-file guard was missed on a sibling path three times in one session —
  each miss reading exactly like the fix. If a check must be remembered at N call
  sites, it will be missed at N+1.

**Known residual** (not fixed, deliberately): `reapIfStale` claims a dead
holder's lock by renaming it aside, then verifies what it got. During that gap
the lock path is briefly vacant, so a second reaper racing the same dead lock can
move a *live* holder's lock aside and admit a concurrent writer. The putback is
create-only (be24e30), so it can no longer clobber a lock acquired in the window,
but the vacancy remains. Closing it means serializing reapers behind their own
lock — which introduces a new stall mode when a reaper dies holding it, and that
tradeoff has not been made. Preconditions are compound (a genuine prior crash,
two reapers racing with adverse scheduling, and a third contender landing in the
window) and it self-heals on the next reap. **No test covers it**: the race needs
sub-millisecond interleaving across three OS processes.
