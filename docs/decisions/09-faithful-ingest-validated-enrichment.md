---
id: 09-faithful-ingest-validated-enrichment
name: Ingest is faithful, enrichment is validated
date: 2026-07-25
status: active
supersedes: null
commits: []
---

# Ingest is faithful, enrichment is validated

**Decision**: Non-answer placeholder values ("unknown", "n/a", "none", bare
punctuation) are stripped from **enrichment output** and left alone in
**source data**. `validateEnrichment` drops them; the converters do not.

**Why**: The symptom is identical either way — the index says someone works at
"none", and a search for that word hits them — but the origin is not. A model
was instructed to leave the field empty and answered "I don't know" in the
field instead; rejecting that is validating an untrusted generator. A LinkedIn
export whose company column literally says "None" is *the owner's own record*,
and silently discarding a value their export contained is editing it. ADR-01
makes faithful ingest of the owner's exports the foundational bet, and ADR-08
already establishes that provenance determines handling — this is that rule one
level down. The observed scale also does not justify an engine-wide change:
2 fields out of 4,566 contacts (0.04%), both source-derived.

**Rejected alternative**: Run the same filter in the converters. Rejected on
fidelity (it edits the owner's record), on reversibility (undoing it means
re-ingesting every source), and on evidence (an engine-wide behavioural change
for every user, designed off n=2). A second alternative — normalize at
`build-index.mjs` rather than at ingest — is **held, not rejected**: the index
is a generated artifact, so cleaning it there would preserve source fidelity
while removing the search noise. That is the fix to reach for if the trigger
below fires.

**Could-be-wrong-if**: placeholder-valued fields exceed **1% of the index**, or
any user reports search noise traceable to them. `enrich-status` reports
`nonAnswerFields` on every run and prints a warning line once the count passes
`max(5, 1% of index)`, so the trigger is observed rather than remembered. If it
fires, apply the held alternative (clean at index build) — not the rejected one.

**How to apply**: New converters do NOT filter field values; they carry the
export through. New model-output paths DO validate, reusing `isNonAnswer` from
`enrich-core.mjs` rather than writing another regex. When adding a field to the
index that could carry a placeholder, extend `countNonAnswers` so the trigger
keeps covering it (today: `name`, `profession`, `employer` — `name` matters
most, since vCard exports routinely carry contacts saved as "Unknown").

Two limits of the filter, both accepted deliberately:

1. **Real values that look like placeholders are NOT in the list.** `nil` and
   `tbd` were removed after review: "NIL" is a major name/image/likeness
   expertise domain, and NIL d.o.o. and Block's TBD are real employers. The
   asymmetry that decides this — a surviving placeholder is searchable junk, a
   destroyed real value is *gone*, because the strip happens at bank time and no
   rebuild recovers it. When extending the alternation, check the candidate
   isn't somebody's actual employer or expertise tag first.
2. **The predicate is English-only.** A non-English backend answering
   "desconocido" / "inconnu" / "未知" is neither dropped nor counted — a blind
   spot in the filter *and* in the trigger that observes it, since both use
   `isNonAnswer`. Acceptable while backends are English-answering; if
   `CLADE_AGENT_CMD` commonly points at one that isn't, the trigger will read
   clean while the index fills up.

## Extension (2026-08-04): enrichment may not silently overwrite an export

**Decision**: For `employer` and `profession`, the owner's own export value wins
over a conflicting web-research value unless the research is `high` confidence
or is corroborated by some first-party value in the merged group. A refused
claim is retained under `unconfirmed`, which nothing indexes.

**Why**: This is the rule above, applied to a second collision. ADR-09 already
holds that a value the owner's export carried is *their record*, and that
silently discarding it is editing it — the placeholder case only asked whether
we may delete such a value. Overwriting one is the same act. The field case:
a LinkedIn URL inside the owner's own export resolved to a same-named stranger,
and the enrichment agent wrote that stranger's a large tech company over the correct
the nonprofit the export named that the export carried, while its own note recorded that the
two disagreed. The right answer was in the owner's file the entire time.

The confidence gate keeps the enrichment feature intact: an export freezes the
employer at connection date, so a job change still refreshes at `high`, and at
any confidence when the export field is empty. Only an UNcorroborated
disagreement is refused.

**Rejected alternative**: give the fold its own conflict test. Tried and
reverted the same day — an unfiltered tokenizer treated any shared word as
agreement, so the nonprofit the export named vs "Department of State" read as the same
employer on "of", reproducing the exact bug through the fix. The comparison now
reuses the merge-time tokenizer (`tokenizeField` + `EMPLOYER_STOPWORDS`, already
hardened by an earlier review) with a title-specific stopword set, so merge-time
and fold-time cannot drift apart again.

**Rejected alternative**: file the refused claim in `notes` as an audit trail.
Rejected because `notes` feeds `search.mjs`'s match haystack and
`export-knowledge.mjs`'s Project file, so a refused a large tech company kept returning
the contact for that employer's search — relocating the bug rather than fixing it.
The enrichment's narrative moves to `unconfirmed` alongside the claim for the
same reason: it argues for the claim by name.

**Known gap, not closed here**: `selectCandidatesFrom` (`enrich-core.mjs`) stops
re-offering a contact once confidence is `high` or `medium`, but this rule only
ADOPTS a conflicting value at `high`. A contact whose current employer is found
at `medium` and disagrees with a stale export therefore keeps the stale value and
is never re-researched. `unconfirmed` makes those contacts findable; wiring them
back into the enrichment queue is follow-up work.
