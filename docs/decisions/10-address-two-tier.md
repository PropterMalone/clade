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
travels wherever `employer` does — search, the Project export, the MCP seam,
enrichment prompts. The hold-back is enforced by **field allow-lists plus leak
tests** (`MCP_SERVED_FIELDS` in `clade-mcp.mjs`, `knowledgeBlock` in
`export-knowledge.mjs`), not by a documented convention.

`location` carries an ORIGIN (`locationSource`: `first-party` | `attested` |
`enrichment`), and the origin gates one specific egress: only an `enrichment`
(public-web) locality may enter a *batched* confirm-tier session. A city derived
from the owner's private address book, or one they attested, is owner-custody
data, and ADR-08 forbids owner-attested facts in a shared session. Solo sessions
carry any origin — private context is already allowed there.

**Why**: An address book without addresses cannot answer either question people
actually ask one — "where does Jane live" and "who do I know in Chicago" — and
Clade dropped the data at ingest (vCard `ADR` explicitly, Google's `Address N`
columns by omission) while the enrichment prompt was *simultaneously* telling the
agent to corroborate identity on city and giving it nowhere to record the answer.
But the two questions want different grades of the same fact, and a street
address is the most sensitive field the corpus would hold.

Of the three egress paths that already existed, ONE would have carried a new
`addresses` field by default: `get_contact`, which serialized whole entries. The
other two are explicit field builders and would have silently dropped it. That
asymmetry is the argument — an allow-list that misses a new field fails visibly,
a blanket dump that includes one fails silently and irreversibly — and it is
ADR-08's How-to-apply §1 in the concrete. It also exposed a standing gap between
the published contract and the reference server: `docs/mcp-kit.md` rule 6 already
required an allow-list, and `clade-mcp.mjs` was serializing wholesale. Closing it
(`MCP_SERVED_FIELDS`) additionally drops `unconfirmed` from the seam, for the
reason `search.mjs` and the export already skip it: a refused web claim may
describe a different person. The allow-list is also DEPTH-1, so `attested` and
`enrichment` are projected rather than served whole — `attested.realName` is the
pseudonym→identity bridge (schema §5.2), and `enrichment.notes` argues for the
very claim `unconfirmed` exists to withhold.

Splitting the field is what makes the rule mechanical rather than remembered:
no code path has to "be careful with addresses", because the shareable grade is
a different field.

**Rejected alternatives**: *store the full address only* and let each consumer
coarsen — inverts the failure mode, since every future consumer must remember to,
and the one that forgets ships a street address to a third party. *Store only the
city*, discarding street/postal at ingest — safe, but forfeits the mail-a-card
use permanently and re-commits the fidelity error ADR-09 names. *A denylist of
forbidden fields* instead of an allow-list of permitted ones — reads as the
smaller change, but keeps blanket serialization as the default and so keeps the
silent-leak failure mode for the *next* field.

**Rejected alternative — the addresses sidecar.** Split the FILE, not just the
field: `build-index.mjs` writes `addresses` to `contacts/addresses.json` keyed by
the durable `keys[]`, out of `unified-index.json` entirely, and the operating
session joins the two on request. This is the decision above pushed to its
conclusion, and the case is real — every consumer of the index becomes safe **by
absence** rather than by an allow-list each one has to get right, retiring a
per-consumer obligation this ADR otherwise leaves standing forever, at roughly
what the allow-list already costs. Rejected on three grounds, in descending
weight:

1. **It does not do what it appears to do.** The same street addresses sit in
   `contacts/normalized/*.json` straight from ingest, and Cloud mode commits
   `contacts/` wholesale. A sidecar protects the *index*, not the *data* — while
   reading as though it protects the data, which is worse than not having it.
2. **The precedent is split, and the divergence is in the half that costs.**
   ADR-08 already stores its strictest class separately
   (`contacts/interactions/*.json`), so separate storage is the incumbent
   pattern, not a novelty. What ADR-08 does *not* do is hide the class from the
   record — it surfaces it as one nested droppable key. Declining to surface is
   the sidecar's actual novelty, and it taxes the single query the hold-back
   exists to serve, on the one reader who is authorized to ask it.
3. **Scope.** It changes a generated file's shape and the private instance's read
   path, for a benefit that is today entirely prospective.

It would have won on exactly one axis, and that axis is live: the class B/C index
push. `docs/mcp-kit.md` requires a refresh to push "a **filtered** copy — the
allow-listed fields only, never the whole file," and the repo ships no such
filter and does not export `MCP_SERVED_FIELDS` for a deployer to reuse. So for a
remote deployment the default action — push `unified-index.json` — moves the most
sensitive field in the corpus onto third-party infrastructure, prevented only by
the documented convention this ADR refuses to rely on. That is the weakest point
of the shipped shape. **Revisit trigger**: the first time anyone runs deployment
class B or C. Reach first for the missing tooling, not the sidecar — export
`MCP_SERVED_FIELDS` and ship a served-index emitter applying the same
projections, so "filtered copy" is a command rather than an instruction.

**Could-be-wrong-if**: `{name, location}` recovers the street address as reliably
as publishing it would. The governing variable is NAME UNIQUENESS, not town size:
a moderately uncommon full name is singular in a city of 100,000, so any
population threshold essentially never fires and reads as an assurance it cannot
provide. US people-search aggregators index on exactly `{full name, city}`, and
the recipient of that pair is a web-search agent we have *instructed to search
for this person* — recovery is the tool's normal operation, not an attack. The
check: sample 20 `{name, location}` pairs from the built index, run each as a
people-search query, and if **more than 25%** surface a street address on the
first page, `location` is the same grade as the street and must come out of
`MCP_SERVED_FIELDS`, off the §5.1 whitelist, and out of both block builders.
Constraints on running it, which are part of the check: **sample only pairs whose
`locationSource` is `enrichment`** — already web-published, so querying them
discloses nothing new. Never submit an `attested` or `first-party` pair; ADR-08
classes those as owner-custody, and the observer here is a re-identification
broker that retains query logs and sells the associated-persons signal a burst of
lookups generates. Run it unauthenticated, in a fresh session, and publish the
pass/fail and nothing else — a locality histogram of a personal address book is
itself a fingerprint, its modal city being the owner's.

**Second falsifier**: if backends return street-level values in `location`, the
field is not structurally coarse. This no longer rests on the prompt —
`looksLikeStreetAddress` refuses them at bank time and `attest.mjs --location` at
the CLI — but it is a **pattern, not a construction**: it is closed against the
number-, unit-, street-type- and ZIP-shaped forms pinned in
`test/enrich-core.test.mjs`, and a value carrying none of those passes. The
falsifier for the guard itself runs the other way: if owners report legitimate
localities being refused (numeric place names like "29 Palms"), it is too broad.

**How to apply**: A new source carrying an address populates BOTH fields via
`buildAddress()` + `deriveLocation()` in `scripts/lib/ingest.mjs` — never one
without the other, never a hand-rolled parse. `location` has FOUR producers, and
only three are guarded at write time: ingest by construction, enrichment in
`validateEnrichment`, `attest.mjs` at the CLI. The quick-add path is not — it
writes `manual.json` through `data-write.mjs`, which validates the path and not
the content — so it is caught only by the fold-time guard in `foldGroup`, and
caught silently. `foldGroup` is also the backstop for anything banked before a
guard existed. A new index field reaches the MCP seam only by being added to
`MCP_SERVED_FIELDS` deliberately, and a nested object needs a projection, not a
top-level entry; any new serializing surface needs its own allow-list and a leak
test beside those in `test/clade-mcp.test.mjs` and `test/export-knowledge.test.mjs`.
`location` follows ADR-09's precedence with two field-specific departures: an
owner-ATTESTED location outranks everything including high-confidence research
(the same precedence `name` already gives `attested.realName`, so this is the
house rule rather than an exception), and an EMPTY first-party value is claimed
only at medium+ confidence, because unlike `employer` empty is the dominant case
here — LinkedIn, Facebook and Bluesky all emit `location: ''` by construction. A
refused claim lands in `unconfirmed`.

**When adding any future field of mixed sensitivity, split it as this one is
split rather than adding a rule about it.** That is the generalizable part.
