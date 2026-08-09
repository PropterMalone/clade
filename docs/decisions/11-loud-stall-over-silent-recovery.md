---
id: 11-loud-stall-over-silent-recovery
name: Loud stall over silent recovery for irreplaceable overlays
date: 2026-08-09
status: active
amends: null
supersedes: null
commits: [69e89c7, b8515e8, 935126b, 4c596d1, be24e30, d747db2, 6e13aa4]
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
`rolodex-knowledge.md`) take the atomic write but **not** the lock. The reason is
regenerability plus atomic replace, not single-writer discipline: nothing
actually prevents two concurrent `build-index` runs, and it does not matter,
because each writes a whole consistent snapshot and the last one wins. The
atomicity is there for concurrent *readers* — the MCP server re-reads the index
on every tool call by design, so a truncating rebuild would hand it a
half-written file.

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
irreplaceable fact gone with **no symptom the owner would recognize as loss** —
at best the contact resurfaces in a later triage batch, reading as "didn't I
already answer this?" rather than as data destruction. Against that, an operator
who must delete a lock file has lost ten seconds and knows exactly what happened.

**Rejected alternative**: *Age-based staleness* — treat a lock held longer than
some cutoff as abandoned and take it. This was not merely considered; it was
**built and shipped** (commit 935126b, 60s cutoff) to cure a real problem: after a
hard crash, the dead holder's pid can be recycled by an unrelated process, so the
liveness probe reports "alive" and the lock is never reaped. It was removed two
commits later (4c596d1) because it converted a **loud** failure into a **silent**
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

1. **A writer that actually hit the wall** — a recorded "Could not acquire"
   stall. This is the PRIMARY observable, because it is the only one that sees
   the canonical failure. Pid reuse means the recycled pid is *alive*, so a
   strand caused by it is indistinguishable from a busy holder by inspection —
   the only way to know it stranded someone is that someone got stuck. It is
   also the only observable that survives the documented recovery: an operator
   who deletes the lock erases every after-the-fact trace.
2. **A stranded lock nobody has collided with yet** — a `.lock` surviving in a
   live data directory for longer than any holder could plausibly still be
   working. Critical sections here measure ~2ms (200 locked updates in 0.36s),
   so the window is not sized against the operation — it is sized against the
   thing that makes a live holder look dead: a laptop suspended mid-write. One
   hour is generously past that and still far short of "nobody noticed for a
   day." Secondary and weaker than observable 1, and its two sub-cases mean
   opposite things, so it is reported rather than auto-classified: a **dead**-pid
   leftover is the self-healing case (the next write reaps it at zero operator
   cost) and only indicates that no write has run since; a **live**-pid lock much
   older than any critical section is either pid reuse or a suspended holder, and
   needs a human to say which.

Threshold: **one or more** of either, in ordinary operation (not induced by a
test), means the no-heuristic stance costs more than it saves — and the answer is
a *safe* recovery (serialize reapers behind their own lock and re-read under that
exclusion), never a return to the age cutoff.

**Evaluated by**:

```sh
# 1. PRIMARY — writers that gave up. withFileLock appends one line here before
#    it throws, so the stall outlives the operator's cleanup. Note ${VAR:-.}:
#    CLADE_DATA_DIR is unset in a local install and forbidden in cloud mode.
D="${CLADE_DATA_DIR:-.}/contacts"
if [ -f "$D/.lock-stalls" ]; then wc -l < "$D/.lock-stalls"; else echo 0; fi

# 2. SECONDARY — surviving locks, reported with holder liveness, not auto-judged
for f in $(find "$D" -maxdepth 1 -name '*.lock' -mmin +60 2>/dev/null); do
  p=$(cat "$f"); kill -0 "$p" 2>/dev/null && echo "$f live=$p (adjudicate)" || echo "$f dead=$p (self-heals)"
done
```

→ `0` and no lines, when the falsifier has NOT fired.

**Status quo check**: check 1 returned `0` and check 2 no lines against the live
instance on the day this shipped. Neither is decorative, verified by planting:
a stall against a live holder writes a `.lock-stalls` line and check 1 returns
`1`. Check 2 was re-verified against its OWN window, not an older one: a
90-minute-old dead-pid lock is reported `dead=… (self-heals)` and disappears once
`attest.mjs` runs and reaps it; a 90-minute-old live-pid lock is reported
`live=… (adjudicate)` and is deliberately NOT auto-classified, because that is
the shape pid reuse presents. (An earlier draft illustrated this with a
20-minute plant left over from a 5-minute window — true, but inert against the
threshold printed beside it.)

**Two ways this falsifier was already wrong, kept because they generalize:**

1. It read `find "$CLADE_DATA_DIR/contacts" …`, and that variable is *unset* in
   the default local install and *forbidden* in cloud mode. Unset, it expands to
   `find "/contacts"`, errors to stderr, and `wc -l` prints `0` — byte-identical
   to a genuine pass. It survived its own status-quo check only because the check
   ran the data path literally instead of the documented command form. **Run the
   falsifier exactly as written, in the mode the reader will run it.**
2. The repaired version then filtered *for* dead-pid locks — which is the case
   the reaper already handles for free — and therefore filtered *out* pid reuse,
   whose whole signature is that the recycled pid looks alive. Meanwhile its
   companion check grepped a `CLADE_LOG` that exists in no code and no document:
   an observable declared load-bearing and instrumented with nothing, which is
   precisely the failure this ADR's own template warns about. **An observable
   needs a producer; name the line of code that writes it.**

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

**Known litter** (accepted): a crash inside `acquire()` or `reapIfStale()` can
leave a `.lock.stage-<pid>` or `.lock.reap-<pid>` file behind. Nothing sweeps
them, and they match neither the `*.lock` glob in check 2 nor the temp-file test,
so they have no observable at all. They are pid-unique, never read, and never
block a later acquisition — litter, not a correctness gap. Named here so a reader
finding one does not mistake it for a stranded lock.

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
