---
id: 02-conservative-entity-resolution
name: Conservative entity resolution with human-ruled ambiguity
date: 2026-07-17
status: active
supersedes: null
commits: [9c180e7, aa94c5c]
---

# Conservative entity resolution with human-ruled ambiguity

**Decision** (amended 2026-07-18, see below): the resolver (`scripts/lib/resolve.mjs`, shell `build-index.mjs`) merges records across sources via union-find, auto-merging ONLY on (a) shared strong identifiers (email / phone last-10 / platform handle / linkedin.com/in slug), or (b) near-exact name + overlapping employer. Exact multi-token names that are unique within *both* sources but lack employer corroboration are NOT auto-merged: they surface in `merge-candidates.json` flagged `reason: "exact-name"` so the review flow can bulk-propose "same" rulings. Everything fuzzier lands there too, flagged `"fuzzy"`. Rulings are recorded in `merge-decisions.json`; a `different` ruling blocks the whole person-pair transitively, checked live against current union-find roots on every comparison.

**Why**: In a personal rolodex, a false merge (gluing two different people into one contact) is far worse than a missed merge (a duplicate the user can later reconcile) — it silently corrupts the record and is hard to notice. So the resolver is deliberately biased toward under-merging and escalating ambiguity to the one entity who actually knows (the owner). The exact-unique-name tier (commit `aa94c5c`) originally *auto-merged*: on 549 LinkedIn + 420 Google contacts the first policy produced 111 candidates, ~100 of them exact-name pairs where one side merely lacked an employer field — pure triage toil, since an exact full-name match across one person's own address books is almost always the same person (uniqueness gate: only fires when the name appears once per source, so two "Alex Sierra"s stay in the human queue). Result: 111 → 23 candidates. The 2026-07-17 review then showed the auto-merge form fired on name equality *alone* whenever both employers were blank — the common case for Facebook/manual records — silently gluing unrelated common names (finding C2, verified by running the resolver). The 2026-07-18 amendment keeps the tier's triage value but demotes it from silent auto-merge to *flagged candidate*: the `exact-name` reason lets one bulk ruling clear the whole set in a minute, while every merge of this class now passes a human eye. Toil is bounded; false merges of this class are zero.

**Rejected alternative**: Aggressive fuzzy auto-merge on name-similarity score alone (the naive approach). Dropped because name-only matching false-merges common names, and in a personal index the blast radius of a wrong merge is a permanently corrupted contact the owner may never catch.

**Could-be-wrong-if**: the human-ruling queue becomes unusably large at scale — if a real multi-source import produces a candidate list the owner won't work through (say >200 pairs for a few-thousand-contact index), the escalate-ambiguity strategy fails in practice and needs a confidence-ranked auto-merge tier for the high-confidence tail. Check: candidate count per 1,000 records after a real multi-source build. Threshold observed acceptable so far: ~23 candidates / ~970 records.

**How to apply**: Any change to the merge logic must preserve "false merge is worse than missed merge." New auto-merge tiers need a uniqueness/conflict guard before they can fire silently; when in doubt, emit a candidate rather than merge. Never auto-merge on name similarity without a corroborating strong signal (employer overlap or cross-source uniqueness).

---

**Amendment 2026-07-18 — review findings fixed.** The 2026-07-17 review (`docs/decisions/_angel-review-2026-07-17.md`) found six verified Criticals; all are fixed and pinned by the test suite (`test/*.test.mjs`, `npm test`):
- **C1** `different` rulings are now transitive: the blocked check runs against *current* union-find roots on every comparison, so a bridging third record can no longer fuse a ruled pair. "Rulings are permanent" holds again.
- **C2** exact-unique-name pairs without employer corroboration route to candidates (`reason: "exact-name"`) instead of auto-merging — the policy change described above.
- **C3** the fold ranks enrichments by confidence + recency and record fields by source authority (manual > linkedin > rest) + connectedOn recency; losing employer values stay visible in notes.
- **C4** short employer names ("3M", "GE", "AT&T") fall back to the compacted whole name, so same-company reads as overlap, not conflict; generic corporate words (inc/llc/company/group/...) are stopworded out of overlap.
- **C5** non-string handle/email/phone values are warn-and-skipped before identifier linking.
- **C6** (enrichment prompt injection) untrusted contact fields are fenced as data-not-instructions, URLs filtered to public http(s) before the model may fetch them, and responses schema-validated before banking — see `scripts/lib/enrich-core.mjs`.

Resolution/folding logic now lives in `scripts/lib/resolve.mjs` (pure, unit-tested); the scripts are thin shells with entrypoint guards.

---

**Amendment 2026-07-18b — phones and emails demoted to corroborated identifiers.** Real-data finding (owner's index): phone numbers and email addresses are legitimately shared *between* people — household landlines glued a family of four into one entry, a shared line merged the owner with his wife, and leaked junk strings ("\* myContacts" as an "email") merged strangers. Policy now: a phone/email collision auto-merges only when the names don't actively disagree; if both records carry multi-token names sharing zero tokens, the pair surfaces in `merge-candidates.json` (`reason: "shared-phone"`/`"shared-email"`, with the shared value in `identifier`) for a ruling. Single-token/blank names ("jwilson" ↔ "Jennifer Wilson") still auto-merge — no conflict evidence, usually correct. Handles and linkedin.com/in URLs remain fully authoritative (single-person platform identities; a name clash there warns but merges). `normEmail` additionally rejects values that aren't plausibly an address, so converter leaks can never become identifiers. Pinned by the shared-identifier test block in `test/resolve.test.mjs`.
