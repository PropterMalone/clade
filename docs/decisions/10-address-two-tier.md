---
id: 10-address-two-tier
name: Address is two-tier — hold-back street, queryable locality
date: 2026-08-06
status: active
amends: 08-provenance-determines-handling
supersedes: null
commits: []
---

# Address is two-tier

**Decision**: Addresses enter the index as **two fields at two privacy grades**,
never one. `addresses[]` (structured, verbatim, street-level) is hold-back: it
reaches no prompt, no export, no MCP result, and is not printed by `search.mjs`.
`location` (a city/region string — "Evanston, IL") is the queryable grade: it
travels wherever `employer` does — search, the Project export, the MCP seam, and
enrichment prompts. The hold-back is enforced by **field allow-lists plus leak
tests** (`MCP_SERVED_FIELDS` in `clade-mcp.mjs`, `contactBlock` in
`export-knowledge.mjs`, both pinned by tests), not by a documented convention.

`location` carries an ORIGIN (`locationSource`: `first-party` | `attested` |
`enrichment`) and the origin gates one specific egress: only an `enrichment`
(public-web) locality may enter a *batched* confirm-tier session. A city derived
from the owner's private address book, or one the owner attested, is owner-custody
data, and ADR-08's table forbids owner-attested facts in a shared session. Solo
sessions carry any origin — private context is already allowed there.

**Why**: An address book without addresses cannot answer either question people
actually ask one — "where does Jane live" and "who do I know in Chicago" — and
until now Clade dropped the data at ingest (vCard `ADR` explicitly, Google's
`Address N` columns by omission) while the enrichment prompt was *simultaneously*
telling the agent to corroborate identity on city and giving it nowhere to record
the answer. But the two questions want different grades of the same fact. A
street address is the most sensitive field the corpus would hold, and of the
three egress paths that already exist, ONE would have carried it by default —
`get_contact`, which serialized whole entries. The other two
(`export-knowledge.mjs` → a claude.ai Project, `enrich-core.mjs` → a research
backend) are explicit field builders and would have silently DROPPED it. That
asymmetry is the argument, and it is stronger stated correctly: an allow-list
that misses a new field fails visibly, a blanket dump that includes one fails
silently. `get_contact` in particular serialized the
*whole* unified entry, so adding one field to the index would have leaked it over
the seam with no code change and no decision — ADR-08's How-to-apply §1, in the
concrete. That also exposed a standing gap between the published contract and the
reference server: `docs/mcp-kit.md` rule 6 already required an allow-list of
fields, and `clade-mcp.mjs` was doing a blanket serialization. Fixed here
(`MCP_SERVED_FIELDS`), which additionally drops `unconfirmed` from the seam for
the same reason `search.mjs` and `export-knowledge.mjs` already skip it: a
refused web claim may describe a different person. The allow-list is also
DEPTH-1, so `attested` and `enrichment` are projected rather than served whole:
`attested.realName` is the pseudonym→identity bridge (schema §5.2), and
`enrichment.notes` argues for the very claim `unconfirmed` was dropped to
withhold.

Splitting the field is what makes the privacy rule mechanical rather than
remembered: there is no code path that must "be careful with addresses", because
the shareable grade is a different field.

**Rejected alternative**: store the full address only and let each consumer
derive coarseness where needed. Rejected because it inverts the failure mode —
every current and future consumer must remember to coarsen, and the one that
forgets ships a street address to a third party. Also rejected: store only the
city and discard street/postal at ingest, which is safe but permanently
forfeits the mail-a-card use and re-commits the fidelity error ADR-09 names
(discarding what the owner's own export carried). Also rejected: hold the street
back with a denylist of forbidden fields rather than an allow-list of permitted
ones — it reads as the smaller change, but it keeps blanket serialization as the
default and so keeps the silent-leak failure mode for the *next* field.

**Rejected alternative — the addresses sidecar** (raised twice in review; recorded
here so it is not re-litigated a third time). Split the FILE, not just the field:
have `build-index.mjs` write `addresses` to `contacts/addresses.json`, keyed by
the durable `keys[]`, and leave it out of `unified-index.json` entirely. The
operating session joins the two files when the owner asks for an address. This
is the decision above pushed to its conclusion, and the case for it is real: it
makes every consumer of the index safe **by absence** rather than by an allow-list
each one has to get right, and it retires a standing per-consumer obligation that
this ADR otherwise leaves in place forever. It costs roughly what the allow-list
already costs.

Rejected on three grounds, in descending weight:

1. **It does not do what it appears to do.** The street addresses are in
   `contacts/normalized/*.json` too, straight from ingest. In Cloud mode the
   owner removes the data-ignore block and commits `contacts/` wholesale, so the
   street data is in the git tree either way. A sidecar protects the *index*, not
   the *data* — and it would read as protecting the data, which is worse than not
   having it.
2. **The precedent is split, and the divergence is in the half that costs.**
   ADR-08 already stores its strictest class separately (`contacts/interactions/*.json`)
   — so separate storage is the incumbent pattern and this alternative is not
   novel there. What ADR-08 does *not* do is hide the class from the record: it
   surfaces it as one nested, droppable key. The sidecar's actual novelty is
   declining to surface, which taxes the single query the hold-back exists to
   serve ("what's Jane's address?") with a join, on the one reader who is
   authorized.
3. **Scope.** It changes a generated file's shape and the private instance's
   read path, for a benefit that today is entirely prospective.

**What it would have won, and what that leaves open.** Exactly one axis, and it
is not hypothetical: the class B/C index push. `docs/mcp-kit.md` requires a
refresh to push "a **filtered** copy — the allow-listed fields only, never the
whole file," and the repo ships no such filter and does not export
`MCP_SERVED_FIELDS` for a deployer to reuse. So for a remote deployment the
default action — push `unified-index.json` — moves the most sensitive field in
the corpus onto third-party infrastructure, and the only thing preventing it is
the documented convention this ADR says it refuses to rely on. That is the
weakest point of the shipped shape and it is prose-only.

**Revisit trigger**: the first time anyone actually runs deployment class B or C.
The cheaper fix to reach for first is not the sidecar but the missing tooling —
export `MCP_SERVED_FIELDS` and ship a served-index emitter applying the same
projections, so "filtered copy" is a command rather than an instruction. Reach
for the sidecar only if that tooling proves insufficient in practice.

**Could-be-wrong-if**: `{name, location}` turns out to recover the street address
as reliably as publishing it would. This is the falsifier that matters, and an
earlier draft of it was **vacuous** — it thresholded on town population (~5% of
localities under ~2,000 people), when the governing variable is NAME UNIQUENESS:
a moderately uncommon full name is singular in a city of 100,000, so a
population test essentially never fires and reads as an assurance it cannot
provide. US people-search aggregators index on exactly `{full name, city}` and
return street addresses, and the recipient of that pair is a web-search agent
we have *instructed to search for this person* — so recovery is the tool's normal
operation, not an attack. Restated as a check that can actually fail: sample 20
`{name, location}` pairs from the built index, run each as a people-search query,
and if **more than 25%** surface a street address on the first page, `location`
is the same grade as the street and must come out of `MCP_SERVED_FIELDS`, off the
§5.1 whitelist, and out of `contactBlock`. Run it locally and publish the
pass/fail and nothing else — a locality histogram of a personal address book is
itself a fingerprint (its modal city is the owner's city). **Sample only pairs
whose `locationSource` is `enrichment`** — those localities are already web-
published, so querying them discloses nothing new. Never submit an `attested` or
`first-party` pair: ADR-08 classes those as owner-custody, and the observer here
is a re-identification broker that retains query logs and sells the associated-
persons signal a burst of lookups generates. Run it unauthenticated, in a fresh
session. The exposure to weigh is the query log, not just what gets published.

A second falsifier, now **closed against the number-, unit-, street-type- and
ZIP-shaped forms** (not "by construction" — it is a pattern, and review broke an
earlier version of it with a labelled prefix, a reordered number, and an ordinal
street name; the shapes it now refuses are pinned in `test/enrich-core.test.mjs`): if backends returned
street-level values in the `location` field despite the prompt constraint, the
field would not be structurally coarse. It no longer rests on the prompt —
`looksLikeStreetAddress` in `enrich-core.mjs` refuses house numbers, unit
designators and ZIPs at bank time, and `attest.mjs --location` refuses them at
the CLI. The falsifier for *that* is a real locality the guard eats: if owners
report legitimate cities being refused (numeric place names like "29 Palms"),
the pattern is too broad.

**How to apply**: A new source that carries an address populates BOTH fields via
`buildAddress()` + `deriveLocation()` in `scripts/lib/ingest.mjs` — never one
without the other, and never a hand-rolled parse. `location` has FOUR producers
(ingest, enrichment, `attest.mjs`, and the operating session writing quick-adds).
Three are guarded at WRITE time — ingest by construction, enrichment in
`validateEnrichment`, `attest.mjs` at the CLI. The quick-add path is NOT: it
writes `manual.json` through `data-write.mjs`, which validates the path and not
the content, so it is caught only by the fold-time guard in `foldGroup`, and
caught silently. `foldGroup` is also the backstop for anything banked before a
guard existed. A new index field reaches the MCP seam only by being
added to `MCP_SERVED_FIELDS` deliberately, and a nested object needs a projection,
not just a top-level entry; any new surface that serializes records needs its own
allow-list and a leak test alongside the ones in `test/clade-mcp.test.mjs` and
`test/export-knowledge.test.mjs`. When adding any future
field of mixed sensitivity, split it here rather than adding a rule about it:
that is the generalizable part of this decision. `location` is subject to
ADR-09's precedence rule, with two field-specific departures: an OWNER-ATTESTED
location outranks everything, including high-confidence research — the same
precedence `name` already gives `attested.realName`, so this is the house rule
rather than an exception — and an EMPTY first-party value is claimed only at
medium+
confidence — because unlike `employer`, empty is the DOMINANT case here
(LinkedIn, Facebook and Bluesky all emit `location: ''` by construction). A
refused claim lands in `unconfirmed`.
