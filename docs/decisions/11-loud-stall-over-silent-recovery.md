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

1. **Proof of death is the only reason to displace a holder.** The lock is
   reaped only after a liveness probe on the recorded pid returns ESRCH. There
   is no timeout, no age cutoff, no "this looks abandoned" heuristic. When the
   lock cannot be taken, the writer **stops with a self-describing error**
   naming the holding pid, how to check it, and when deleting is safe — it does
   not proceed, and it does not recover automatically.
   *This states the reaper's decision CRITERION, not an unconditional outcome.*
   A residual race can still admit a second writer without anyone having proved
   the first dead — see **Known residual** at the end, which is not yet closed.
   A maintainer citing this property as settled would be wrong to treat
   concurrent-writer admission as ruled out.
2. **The whole read-modify-write happens inside the lock.** Locking only the
   write still loses data: it is the stale *read* that makes a sibling's entry
   disappear.
3. **Replace, never truncate.** `atomicWriteFileSync` writes a sibling temp,
   `fsync`s it, inherits the target's mode (when the target already exists —
   a first write gets the process default), and renames over it. A reader sees
   the old file or the new one, never a partial one, and a crash leaves the
   previous contents intact. Scoped to POSIX same-filesystem `rename(2)`, which
   is guaranteed here because the temp is always a sibling of the target.

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
  `attest.mjs` calls, run twice: one run lost a single entry cleanly (19 of 20
  survived, valid JSON); the other interleaved into *invalid JSON*, and the
  processes that read it next died in a cascade. The race is nondeterministic,
  so both are outcomes of the same defect — cite the range, not either endpoint.
  Every process exited 0 and printed "Attested" in both runs. The success
  message measured the mechanic (a file was written), not the effect (the entry
  is present).
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
operators. **Two observables, because either alone is blind:**

1. **A stranded lock nobody has collided with yet** — a `.lock` surviving in a
   live data directory whose recorded pid is dead or foreign. The pid check is
   part of the observable, not decoration: this ADR's own rejected alternative
   rests on a live holder outlasting a time cutoff (suspend, swap, SIGSTOP), so
   an age test alone would count a correct, live holder as evidence against the
   decision it supports.
2. **A writer that actually hit the wall** — an occurrence of the "Could not
   acquire" error in ordinary operation. This one is load-bearing because the
   documented recovery *destroys the evidence for observable 1*: the operator
   deletes the lock and the count returns to zero. Strandings that impose the
   real cost are exactly the ones erased before any sweep runs, so a check that
   only counts surviving locks can read `0` forever while operators are stalling
   weekly.

Threshold: **one or more** of either, in ordinary operation (not induced by a
test), means the no-heuristic stance costs more than it saves — and the answer is
a *safe* recovery (serialize reapers behind their own lock and re-read under that
exclusion), never a return to the age cutoff.

**Evaluated by**:

```sh
# 1. stranded locks whose holder is gone — note the ${VAR:-.} default
for f in $(find "${CLADE_DATA_DIR:-.}/contacts" -maxdepth 1 -name '*.lock' -mmin +5 2>/dev/null); do
  kill -0 "$(cat "$f")" 2>/dev/null || echo "$f"
done | wc -l

# 2. writers that gave up (the evidence deletion destroys)
grep -c 'Could not acquire' "${CLADE_LOG:-/dev/null}" 2>/dev/null || echo 0
```

→ `0` and `0` when the falsifier has NOT fired.

**Status quo check**: both returned `0` against the live instance on the day this
shipped. The threshold is not decorative: planting a 20-minute-old lock file in a
scratch data dir makes check 1 return `1`. And it discriminates the *right* case —
a stranded lock holding a genuinely dead pid is reaped automatically on the next
write (verified: planted, then `attest.mjs` succeeded and the count returned to
`0`), so a survivor indicates pid reuse specifically, which is the scenario this
ADR declines to auto-handle.

**A note on how this falsifier was nearly useless**, kept because it generalizes:
the first version was `find "$CLADE_DATA_DIR/contacts" …`, and `CLADE_DATA_DIR` is
*unset* in the default local install and *forbidden* in cloud mode. Unset, it
expands to `find "/contacts"`, errors to stderr, and `wc -l` prints `0` — byte
identical to a genuine pass. In two of three documented deployment modes it was a
constant zero. It survived a status-quo check only because that check ran the data
path literally instead of the documented command form. **Run the falsifier exactly
as written, in the mode the reader will run it.**

**How to apply**:

- **Any new writer of `attested.json` or `merge-decisions.json`** goes through
  `updateJsonFile`, with a shape validator (`expectEntryMap` / `expectDecisions`).
  Do the whole read-modify-write inside the callback; never read outside it and
  write inside.
- **Any new writer of a generated data file** uses `atomicWriteFileSync`. A bare
  `writeFileSync` on a data path is a regression, and
  `test/seam-hardening.test.mjs` scans **every** `scripts/*.mjs` plus `search.mjs`
  for one — enumerated, so a script added tomorrow is covered the day it lands.
  A write that genuinely is not overlay data marks itself `not-data:` with a
  reason; that is the only exemption, and it is greppable.
  (The first version of this scan hardcoded six file paths, which is the
  per-call-site guard the next bullet warns about, wearing a chokepoint's
  description.)
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

**Known gap — `data-write.mjs`'s targets are irreplaceable too, and get the
weaker tier.** `profile/about-me.md` (the interview) and
`contacts/normalized/manual.json` (quick-add) are owner-supplied and exist
nowhere else, which is this ADR's own definition of what earns the lock — but
`data-write.mjs` takes whole-file content on stdin and calls
`atomicWriteFileSync` with no lock. Worse, the read-modify-merge happens in the
*calling agent's* context, which is structurally the unguarded read-modify-write
this ADR proved dangerous, moved one layer up. It is accepted for now on a
frequency argument rather than a safety one: the whole-content-per-call design
does not invite the per-key parallel fan-out that `attest.mjs --key` does, so
concurrent callers are rare where they were routine. That is a weaker reason than
the rest of this document rests on. If quick-add processing ever writes
`manual.json` from more than one process, this needs the lock.

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
