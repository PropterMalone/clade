> **RESOLVED 2026-07-18 — historical record.** Every finding below was fixed
> the next day (commits `7458869` through `50fa571`; ADR-02 amendments a+b) and
> is pinned by the test suite (`npm test`). This report is kept as the review
> record and the origin of the test plan — it does NOT describe the current
> code.

# /angel review — Clade core scripts — 2026-07-17

**Battery:** naive (Haiku), adversarial (Sonnet), hypercritical (Sonnet), test (Sonnet) — multiball **N=2** (8 persona passes).
**Mode:** file-scoped full review (4 named files; no diff anchor).
**Files reviewed:** `scripts/build-index.mjs` (336 LOC), `scripts/enrich-batch.mjs` (263), `search.mjs` (121), `scripts/export-knowledge.mjs` (67).
**Pre-flight:** `node --check` passes on all 4 files. No test/lint/build infra to run (package.json defines only `build-index` + `search`; zero test files) — infra step skipped, noted.
**Model note:** on an Opus leg, so `test` ran on Sonnet per the Fable-lapse ladder (test→Sonnet, not Opus).
**Verification:** the two highest-severity merge bugs (C1, C2) plus C3/C4/C6-class were **independently re-verified by the Hypercritical pass running the actual `build-index.mjs` against synthetic fixtures** — `[ran]`-tier, not static reasoning. Quoted results below are that persona's observed script output.

## Verdict: CHANGES REQUIRED

Six Critical findings, all in `build-index.mjs` except the enrichment prompt-injection one. Four are **silent** merge/data-integrity bugs (no crash, no warning, wrong output) — exactly the highest-severity class for a rolodex: two glue different people together, one silently overrides a human "different" ruling, one corrupts the identity fields the whole search use-case depends on. The union-find core itself is sound; the bugs live in the *edges* feeding it (the exact-name gate, the employer tokenizer, the blocked-pair snapshot, the handle normalizer) and in the fold step that collapses a group into one record.

## Severity counts (deduplicated)

| Severity | Count |
|---|---|
| Critical | 6 |
| Important | 12 |
| Minor | 8 |
| Noted | ~6 |

---

## Critical (blocks ship)

### C1 — Transitive bridge silently defeats a human "different" ruling → FALSE MERGE  `[significant]`
`scripts/build-index.mjs:164-171` (blockedGroupPairs snapshot) + `:213-226` (fuzzy unions)
**Caught by:** hypercritical (both passes, pass-2 verified by running script), test (both passes).
**Highest-severity finding in the review.** `blockedGroupPairs` is computed **once**, before the fuzzy pass, as a snapshot of `[find(ia), find(ib)]` root-pairs. The fuzzy loop then performs `union()`s that mutate roots, but the blocked check at `:215` still compares against the stale snapshot, and — more fundamentally — only ever inspects the *literal pair currently being compared*, never the transitive closure of a blocked side. A third same-surname record that fuzzy-matches both members of a blocked pair bridges them into one group without either blocked pair ever being directly compared.

Verified by running the script: with `linkedin:x1` ("John Smith", IBM Global Services) and `facebook:y1` ("John Smith", IBM Watson) explicitly ruled `"different"` in `merge-decisions.json`, adding one bridging record (`twitter:z1`, "John Smith", employer "IBM") produced `"Unified index: 1 people from 3 records"`; removing the bridge restored 2 people. This breaks CLAUDE.md's documented guarantee ("Rulings are permanent — decided pairs never resurface") for any common name + generic employer, and it is order-dependent (`readdirSync().sort()` + record order) so it can appear/vanish when an unrelated source file is added.
**Fix:** maintain a live per-root blocked-partner set that merges on every `union()` and is checked before any union is allowed — not a one-time precomputed pair snapshot.

### C2 — Exact-name auto-merge fires with ZERO corroborating identifier → FALSE MERGE  `[moderate]`
`scripts/build-index.mjs:219-226`
**Caught by:** hypercritical (pass-2 verified), test (both passes).
The `score === 1 && …uniqueInSource… && !employersConflict(a,b)` branch unions two records on **name equality alone** whenever neither side has a *conflicting* employer — and "both employers absent" is not a conflict (`employersConflict` requires both present, see C-truth-table below). Both-blank is the common case for Facebook/Twitter/manual records. This contradicts the file's own header ("auto-merge only on shared strong identifiers … or near-exact name + employer overlap", `:13-16`) and CLAUDE.md's policy.

Verified by running the script: two unrelated "Michael Chen" records (LinkedIn + Facebook, both empty `employer`) were silently auto-merged into one person, with **no entry in `merge-candidates.json`** — never reaching human review, unlike the `score >= 0.8` candidate path.
**Fix:** require the exact-name branch to also have at least one corroborating signal (shared strong identifier OR positive employer overlap), or route name-only-unique pairs to `merge-candidates.json` instead of auto-merging.

### C3 — Fold step picks winning field by array position, not confidence/recency → SILENT DATA CORRUPTION  `[moderate]`
`scripts/build-index.mjs:270-271` (enrich/attest `.at(-1)`) + `:300-306` (`.find(Boolean)`)
**Caught by:** hypercritical (pass-2, two verified repros), naive, test.
`enrich`/`attest` are selected with `.at(-1)` (last by group array order); `profession`/`employer`/`bio` with `.find(Boolean)` (first by group array order). Neither consults `enrichedAt`, `confidence`, or source authority — both pick by incidental directory alpha-sort.

Verified by running the script: (1) merging a `confidence:"high"` LinkedIn record (real name confirmed) with a `confidence:"unidentified"` gmail record produced a unified entry with confidence **`"unidentified"`** — the confirmed identity silently discarded. (2) Merging a 2015 defunct-employer Facebook record with a current Deloitte LinkedIn record (legit email-shared merge) surfaced the **stale 2015 employer/title**, purely because `"facebook"` sorts before `"linkedin"`. This corrupts exactly the `employer`/`profession` fields that `search --domain/--role` and the "who do I know at X" use-case read.
**Fix:** rank group records/enrichments by a confidence+recency key before selecting the winning scalar for each field; keep the non-winning values in `notes` rather than dropping them.

### C4 — `employerTokens` drops all ≤2-char tokens → false "conflict" + missed merge for real companies  `[trivial]`
`scripts/build-index.mjs:151-154` + `:190-191`
**Caught by:** hypercritical (pass-2, tested directly).
The token filter `t.length > 2` yields an **empty set** for `"3M"`, `"GE"`, `"HP"`, `"EY"`, `"AT&T"`. Consequences: (a) `employerOverlap` is always false for two people at such a company, so the `score>=0.9 && employerOverlap` safe-merge branch never fires; (b) worse, `employersConflict` returns **true** for two records both at "3M" (both present, no overlap) — the exact-name branch then treats same-company as *conflicting* and blocks/splits a real person. A "failed merge" for a set of common Fortune-500 employers, not a contrived edge.
**Fix:** lower/remove the length floor for employer tokens (keep short-but-alphanumeric tokens like `3m`, `ge`, `hp`), or normalize known short company names.

### C5 — Non-string / falsy handle values false-merge unrelated people  `[trivial]`
`scripts/build-index.mjs:89-95` (link guard) + `:101-102` (handles loop)
**Caught by:** test (both passes), adversarial-adjacent.
`link()` guards with `if (!value) return`, but the handles loop computes `String(handle).toLowerCase()` **before** the guard: `String(null)`→`"null"`, `String(undefined)`→`"undefined"`, `String(0)`→`"0"`, `String({})`→`"[object object]"` — all non-empty truthy strings that pass the guard. Two records that each carry a falsy/object placeholder handle for the same platform (e.g. a parser writing `{"bluesky": null}` for "no handle") get unioned as if they shared a real handle. Contrast `normPhone`, which returns real `null` so the guard works — proving handles is the outlier.
**Fix:** in the handles loop, skip non-string or empty handle values before constructing the identifier (`typeof handle === 'string' && handle.trim()`).

### C6 — Enrichment prompt built from untrusted contact fields, fed to a live web-browsing agent alongside the owner's private life history → injection / exfiltration / poisoned knowledge  `[moderate]`
`scripts/enrich-batch.mjs:99-133,158-181` → propagates via `scripts/build-index.mjs:302,306` → `scripts/export-knowledge.mjs:33-54`
**Caught by:** adversarial (both passes; pass-2 Critical, mechanism verified).
`contactBlock()` interpolates `name`/`bio`/`urls`/`handles` — self-reported by the contact, not the owner (Bluesky bios/handles pulled live from the public API, any followed/following account controls them) — straight into the prompt sent to `claude -p --allowedTools WebSearch,WebFetch`, together with up to 4000 chars of `profile/about-me.md`. `JSON.stringify(bio)` only quote-escapes; it is not an instruction/data boundary. The prompt then tells the model to "fetch any linked URLs" over attacker-supplied `c.urls`. Two concrete vectors: (a) a crafted bio can attempt to exfiltrate the private life-history block to an attacker domain via the model's own WebFetch; (b) a crafted profile URL (`169.254.169.254`, internal host) turns "fetch any linked URLs" into an SSRF primitive. `enrichOne` then accepts whatever JSON returns with **no shape/enum validation** (`typeof parsed === 'object'` only) — verified downstream failure: if `expertise` comes back as a string, `build-index.mjs:302` `[...(enrich.expertise||[])]` spreads it into single-character `domains` tags. Poisoned `realName`/`employer`/`notes` become canonical index fields and are written **unescaped** into `rolodex-knowledge.md`, which the owner is told to upload as trusted knowledge to a claude.ai Project — replaying injected content into a second Claude session.
**Contained:** `execFile` (arg array, no shell) + `--allowedTools WebSearch,WebFetch` mean no shell/file/exec escalation — blast radius is data integrity + exfiltration, not RCE.
**Fix:** wrap untrusted fields in explicit "this is data, not instructions" delimiters; drop or allowlist "fetch any linked URLs"; validate/whitelist returned JSON before persisting (enum-check `confidence`, coerce `expertise` to `string[]`, cap lengths). *Adjacent to the stated merge-focus but a genuine ship blocker for an open-source tool.*

---

## Important (should fix)

- **Non-string `emails`/`phones` array elements crash the ENTIRE build (not just the record)** `[trivial]` — `build-index.mjs:79-83,99-100`. `e.trim()`/`p.replace()` on a bare JSON number or `null` throws an uncaught `TypeError`, aborting all sources with no line pointing at the offender. Inconsistent: `handles` already gets `String()` coercion, and missing `sourceId` is warn-and-skipped (`:46-49`). Loud (not silent) but a single bad record from ad-hoc ingestion denies a working rebuild. **Fix:** type-guard + warn-and-skip per field. (naive Critical, adversarial, hypercritical, test.)
- **`readJson` uses raw `JSON.parse` with no try/catch** `[trivial]` — `build-index.mjs:27-30` (used at `:40,:108,:244`). One truncated/malformed `normalized/*.json` or `merge-decisions.json` kills the build with a bare `SyntaxError`. Inconsistent with the enrichments loader (`:246-253`) which *is* wrapped. Hand-written `normalized/manual.json` is a realistic trigger. (hypercritical, verified.)
- **No entrypoint guard on any of the 4 scripts → import runs the full CLI; importing `enrich-batch.mjs` can spawn real `claude -p` and spend** `[moderate]` — `build-index.mjs:54-56`, `enrich-batch.mjs:260-263`, `search.mjs:18-28`, `export-knowledge.mjs:18-22`. Blocks unit-testing every pure function; the import-time real-API-spend is an active footgun. **Fix:** gate CLI bodies behind `import.meta.url === \`file://${process.argv[1]}\`` and export the pure functions. (test Critical — reclassified Important.)
- **Strong-identifier auto-merge has no conflict check and never surfaces for review** `[moderate]` — `build-index.mjs:90-104`. Any shared normalized email/phone/handle/linkedin unconditionally unions, with no name/employer sanity check, unlike the fuzzy path. A single colliding/mis-scraped identifier glues two people silently. Partly by design (strong IDs are trusted) but worth a disagree-name spot-check flag. (adversarial.)
- **TOCTOU on concurrent enrichment runs → duplicate quota spend + batch-file overwrite** `[moderate]` — `enrich-batch.mjs:51-93,217,241-247`. Two runs (manual+cron) read the same "not yet attempted" snapshot and pay for the same candidates; batch filenames truncated to the second (`:242`) can collide and silently overwrite. This is the exact bug the sibling Krolodex project already patched with `reserve-burn --shard I/N` (commit `1272b21`). **Fix:** lockfile guard + uuid/pid batch-filename suffix. (adversarial.)
- **`LIMIT_HIT_RE` misclassifies ordinary research failures as usage-limit hits** `[moderate]` — `enrich-batch.mjs:46-47,172-180`. Matches free text `rate.?limit`/`usage.?limit`/`\b503\b`/`over(loaded|capacity)`. Verified: a bio mentioning "API rate limiting," a note quoting "Usage Limits," or an unrelated site's 503 all trip it — a genuine "couldn't identify" for a tech contact gets requeued as throttled, backed off, and can stop the whole batch with the misleading "out of quota" message. **Fix:** detect limits from process/exit signal, not free-text scan of model output. (hypercritical verified, adversarial.)
- **`execSync('node build-index.mjs', {stdio:'ignore'})` swallows rebuild failures silently** `[moderate]` — `enrich-batch.mjs:245-247`. If the rebuild throws (e.g. C1-class crash), it's fully silent and the index stalls at a stale snapshot through every subsequent batch. **Fix:** log the caught error / drop `stdio:'ignore'`. (hypercritical.)
- **`enrichOne` never inspects `err` from `pexec`** `[trivial]` — `enrich-batch.mjs:158-181,137-142`. A broken `claude` binary/env produces the same `{failed:true}` as a genuine miss, for every contact, with no diagnostic — operator can't distinguish "tool broken" from "hard to identify." **Fix:** log `err.message` when present. (hypercritical.)
- **Malformed/wrong-shaped enrichment value is permanently marked "attempted" and never retried** `[moderate]` — `enrich-batch.mjs:51-60`. `attemptedKeys()` checks only `Object.keys`, never value shape. A bare-string value (hand-edited/partial batch file) degrades to `confidence:'none'` in the fold with no crash, but the key is now permanently attempted → silent, permanent under-identification. **Fix:** validate enrichment record shape; treat malformed as un-attempted. (test.)
- **`export-knowledge.mjs` junk filter drops legit handle-only contacts AND passes key-shaped names** `[moderate/trivial]` — `export-knowledge.mjs:29`. `/^\p{L}/u.test(name)` drops a real `name:"420blaze_dave"` (digit-start handle, verified — silently counted in `skipped`) while letting a fallback key `"linkedin:jane-wilson"` through (starts with a letter) into the uploaded markdown as a junk `## linkedin:jane-wilson` person. The `skipped` counter can't distinguish junk from real. (hypercritical verified, test.)
- **Generated `id` uniqueness (a documented invariant) can collide** `[trivial]` — `build-index.mjs:286-291`. `usedIds` suffixing is keyed only by the current slug: person X ("Jane Wilson") gets `jane-wilson`; person Y literally named "Jane Wilson 2" slugifies to `jane-wilson-2`; a third unmerged "Jane Wilson" also gets `jane-wilson-2` → collision, violating schema.md's "unique within one build." **Fix:** dedupe the final id against all assigned ids, not just the slug counter. (test both passes, hypercritical.)
- **Name fallback = `keys[0]` produces a person whose display name is a raw key** `[moderate]` — `build-index.mjs:273-278`. Schema permits records identified only by emails/handles; the fallback chain ends at `keys[0]` (e.g. `"linkedin:some-id"`), which then flows through search and the export filter as if it were a name. Two files depend on the unstated "name is always human prose" contract. **Fix:** synthesize a readable name (email localpart / handle) or flag as `needs-name`. (test both, hypercritical.)

---

## Minor (quality improvement)

- **`search.mjs --limit` non-numeric → `NaN` → silent zero rows while reporting N matches** `[trivial]` — `search.mjs:46,105,107`. `parseInt('abc')`→`NaN`; `.slice(0,NaN)`→`[]` and the "(showing N)" hint is suppressed. Prints "12 matches:" then nothing. **Fix:** `Number.isFinite(n) ? n : 50`. (all four personas.)
- **ANSI / control-character injection via unsanitized `console.log` of contact fields** `[trivial]` — `search.mjs:107-121`, `enrich-batch.mjs:220-221`. Attacker-controlled display names/bios can carry escape sequences (OSC 52 clipboard write, cursor manipulation) that fire in modern terminals when the owner searches their own rolodex. **Fix:** strip `/[\x00-\x1f\x7f]/g` before printing. (adversarial both passes.)
- **Key-shaped-name filter is duplicated and independently wrong in two files** `[moderate]` — `enrich-batch.mjs:88` (`/^[a-z]+:/`) vs `export-knowledge.mjs:29` (`/^\p{L}/u`). Both miss `"google-contacts:xyz"` (hyphen breaks the first; letter-start passes the second) → a DB key gets a wasted enrichment web-search / an empty export stub. **Fix:** one shared `isKeyShapedName` helper, or mark these records explicitly in build-index. (hypercritical, test.)
- **`handles` fold is last-writer-wins on a platform conflict with no candidate surfacing** `[trivial]` — `build-index.mjs:297`. `Object.assign({}, ...handles)` silently drops an earlier source's handle when a later source lists a different one for the same platform — unlike name/employer, no review queue. (test, naive.)
- **`sourceTag` first-letter abbreviation collides** `[trivial]` — `search.mjs:109`. "gmail" and "google-contacts" both → "G" → ambiguous "G+G". Cosmetic. (hypercritical.)
- **Emptying `contacts/normalized/` leaves stale `unified-index.json` served with no staleness signal** `[trivial]` — `build-index.mjs:54-57`. Early-exit doesn't rewrite outputs; `search.mjs` keeps serving the old index. Plausibly intentional safety valve, but untested. (test, hypercritical.)
- **Phones not normalized in the fold while emails are** `[trivial]` — `build-index.mjs:295-296`. `emails` uses `.map(normEmail)`, `phones` is raw — inconsistent dedup. (naive.)
- **`merge-decisions.json` ruling referencing a missing key fails silently** `[trivial]` — `build-index.mjs:110-116`. Hand-edited file; a typo'd/drifted key no-ops with no output → a "different" ruling that can never apply. **Fix:** `console.warn` on unresolved key. (hypercritical.)

---

## Noted (awareness only)

- `normPhone` last-10-digit matching can merge different-country numbers sharing trailing digits — already a commented, accepted tradeoff.
- Unbounded O(k²) pairwise compare per surname bucket — a nuisance only for a very large same-surname cluster.
- The owner's full `about-me.md` transits every per-contact `claude -p` subprocess — confirm that subprocess's own transcript logging doesn't persist it somewhere the privacy rules don't account for.
- `parseJsonBlock`'s non-greedy fence regex can truncate on a stray ``` in the model's own `notes` (safely → null downstream).
- Non-ASCII/symbol-only names collapse to `id:"contact"`/`"contact-2"` — schema already documents `id` as non-durable.
- Confirmed no PII-in-git leak path: `contacts/`, `imports/`, `profile/` are gitignored (`git ls-files` clean) — matters for the open-source trajectory.

---

## Test plan (highest-value missing tests — from the Test persona)

The pure functions are directly unit-testable once an entrypoint guard exists (see Important #3). Priority fixtures, each pinning a verified bug above:

1. **Blocked-pair transitive bridge (C1):** 3 same-surname records A/B/C, A-vs-B ruled "different", C bridges → assert A and B never share a unified group.
2. **Exact-name both-employers-blank (C2):** two unrelated same-name records, both empty employer → assert they land in `merge-candidates.json`, not auto-merged.
3. **Fold field selection (C3):** merge high-confidence+recent with low-confidence+stale → assert winning `confidence`/`employer`/`profession` come from the authoritative record.
4. **Employer tokenizer (C4):** two "Jane Doe @ 3M" records → assert `employerOverlap` true and no false conflict.
5. **Non-string handle (C5) / non-string email-phone (Important #1):** records with `handles:{bluesky:null}` and `emails:[null]`/`phones:[15551234567]` → assert no false merge and no crash (warn-and-skip).
6. **Employer-conflict truth table:** all four cells (both-present-overlap / both-present-no-overlap / both-blank / one-blank) pinned.
7. **Fuzzy thresholds:** boundary values around 0.8/0.9/1.0 locked so a `0.7→0.07` typo is caught.
8. **`id` uniqueness:** synthetic "Jane Wilson" / "Jane Wilson 2" / third "Jane Wilson" → assert all `id`s distinct.
9. **`parseJsonBlock` / `seedScore` / `matchesQuery`:** already pure — extract and cover first (lowest effort).

---

## Integration notes

- Multiball N=2 honored (8 persona passes: 2× each of naive/adv/hyper/test). Integrated inline (Opus [1m] context) rather than dispatching a separate integrator — 4-persona set fits comfortably and avoids an extra heavy dispatch.
- Verification: C1–C4 and the C6 sub-mechanism were re-run against fixtures by the Hypercritical/Adversarial passes (`[ran]`-tier). No separate verifier stage dispatched; the persona repros stand as the confirmation.
- Cross-persona convergence was high on the merge bugs — C1 and C2 independently in hypercritical + test, C3 in hypercritical + naive + test. The security Critical (C6) came only from adversarial (both passes) as expected for its lane.
- Pre-flight infra (test/lint/build) skipped: none exists. This review has no baseline to diff against — establishing test infra (Important #3) is the enabling first step for everything in the Test plan.
