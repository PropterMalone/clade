---
id: 06-clade-data-dir
name: CLADE_DATA_DIR — data ops against an out-of-tree data directory
date: 2026-07-23
status: active
supersedes: null
commits: []
---

# CLADE_DATA_DIR — driving data ops against an out-of-tree data directory

**Decision**: Engine shells resolve every built-in data path through a single
pure seam, `scripts/paths.mjs`: `dataRoot()` returns
`process.env.CLADE_DATA_DIR || process.cwd()`, and `dataPath(...segs)` joins under
it. The default (var unset) is `process.cwd()`, so the pinned cwd-relative
direct-invocation contract is byte-for-byte unchanged. With the var set, a session
cwd'd in *this* engine repo drives ingest/merge/enrich/search against a private
data directory that lives **outside** the public repo tree — the enabler for
retiring the private data instance's *repo* to a plain (git-backed) data dir.

**Why**: The convergence (ADR-03 two-surface model) left the engine here and the
owner's data in a separate instance repo. To collapse that to "one repo you open
(Clade) + one data dir you never develop in," the engine has to be able to target
an external data root without the operator `cd`-ing into it. An env var read in
one place does that while preserving both engine-consumability contracts
(cwd-relative default; zero runtime deps — `paths.mjs` imports only `node:path`).
The design was `/angel`-gated (5 personas ×N=2, 2026-07-23); the gate found the
naive "wrap the 9 scripts" version would leak owner data into the public tree,
which shaped four load-bearing refinements below.

**Rejected alternative**: A separate `CLADE_IMPORTS_DIR` (and/or a threaded
resolved-paths object, and/or an in-repo config file). Rejected: one private dir
holds `contacts/` + `imports/` + `profile/` — a second var is granularity with no
consumer; a threaded object would touch `lib/*` signatures that are deliberately
100% data-as-args; an in-repo config file adds tracked-vs-untracked private-path
state to a pseudonymous public repo. `CLADE_*` env vars are already the engine's
extension idiom (`CLADE_AGENT_CMD`, `CLADE_ENRICH_GUARD`).

**Could-be-wrong-if**: a data-path write reaches the public repo tree under normal
use — observable as any owner PII (a contact name/email, `about-me` text) landing
in `git status` of the Clade repo, or the seam-totality test
(`test/seam-totality.test.mjs`) passing while a shell still writes to cwd. Concrete
threshold: one non-gitignored owner-data file in the engine repo working tree
after a `CLADE_DATA_DIR` session. If that happens, the seam is not total and the
env-var approach needs a hard tripwire (refuse all writes when cwd == engine repo
and no var set), not just the current stderr warning.

**How to apply** — the gate's refinements are binding on all future path work:
1. **Only built-in DEFAULTS route through `dataPath()`.** User-supplied CLI paths
   (argv, `--flags`) keep normal cwd semantics — `dataPath` uses `join`, which
   mangles an absolute user path and re-anchors a relative one. `--proposals`
   (PII output) is the exception: a *relative* value resolves under the data root.
2. **`CLADE_DATA_DIR` must be absolute** and outside the engine repo — `dataRoot()`
   throws otherwise (Node never expands `~`, so a relative value would resolve
   inside cwd = the public repo). It must also exist (a typo'd absolute path
   throws rather than spawning a fresh empty tree).
3. **Agent-direct overlay writes go through helper scripts**, not raw file edits:
   `attest.mjs`, `record-merge.mjs`, `data-write.mjs`. An env var cannot govern
   the operating session's own Write-tool calls, so the pipeline invokes these
   (which resolve through the seam) instead of hand-editing `attested.json` /
   `merge-decisions.json` / `about-me.md` / `manual.json`.
4. **New data-path literals must be `dataPath`-wrapped** — enforced by
   `test/seam-totality.test.mjs` (a bare `'contacts/…'` fails the suite). Control
   files (`.stop-enrichment`) stay cwd-relative on purpose; the lock
   (`.enrich-lock`) moved into the data root.
5. **Cloud mode (ADR-03 / CLAUDE.md) must never set `CLADE_DATA_DIR`** — there,
   git commits to the private repo *are* the persistence, so an out-of-tree data
   root would silently vanish at session teardown.
