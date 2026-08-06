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
`location` (a city/region string — "Evanston, IL") is public-profile grade and
travels wherever `employer` does, including batched confirm-tier enrichment
sessions. The hold-back is enforced by a **field allow-list plus a test**
(`SHAREABLE_FIELDS` in `clade-mcp.mjs`, pinned by `test/clade-mcp.test.mjs`),
not by a documented convention.

**Why**: An address book without addresses cannot answer either question people
actually ask one — "where does Jane live" and "who do I know in Chicago" — and
until now Clade dropped the data at ingest (vCard `ADR` explicitly, Google's
`Address N` columns by omission) while the enrichment prompt was *simultaneously*
telling the agent to corroborate identity on city and giving it nowhere to record
the answer. But the two questions want different grades of the same fact. A
street address is the most sensitive field the corpus would hold, and the three
egress paths that already exist (`export-knowledge.mjs` → a claude.ai Project,
`clade-mcp.mjs` → any consuming session, `enrich-core.mjs` → a research backend)
would each have carried it by default. `get_contact` in particular serialized the
*whole* unified entry, so adding one field to the index would have leaked it over
the seam with no code change and no decision — hazard 2 of ADR-08, in the
concrete. That also exposed a standing gap between the published contract and the
reference server: `docs/mcp-kit.md` rule 6 already required an allow-list of
fields, and `clade-mcp.mjs` was doing a blanket serialization. Fixed here
(`SHAREABLE_FIELDS`), which additionally drops `unconfirmed` from the seam for
the same reason `search.mjs` and `export-knowledge.mjs` already skip it: a
refused web claim may describe a different person.

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

**Could-be-wrong-if**: a locality string turns out to re-identify as precisely as
a street address for a material share of contacts. Concretely: if more than ~5%
of `location` values resolve to places with a population under ~2,000 — where
"lives in <town>" plus a name is a lookup — then `location` is not a coarser
grade, it is the same grade with fewer characters, and it belongs in
`HOLDBACK_FIELDS` with the street. Check by bucketing the built index's
`location` values against any population table. A second falsifier: if enrichment
backends begin returning street-level values in the `location` field despite the
prompt constraint, the field is not structurally coarse and needs a validator,
not an instruction — measurable as any banked `location` matching a street
pattern (leading house number, or a street-type suffix).

**How to apply**: A new source that carries an address populates BOTH fields via
`buildAddress()` + `deriveLocation()` in `scripts/lib/ingest.mjs` — never one
without the other, and never a hand-rolled parse. A new index field reaches the
MCP seam only by being added to `SHAREABLE_FIELDS` deliberately; any new surface
that serializes records needs its own allow-list and a leak test alongside the
one in `test/clade-mcp.test.mjs`. When adding any future
field of mixed sensitivity, split it here rather than adding a rule about it:
that is the generalizable part of this decision. `location` is subject to
ADR-09's precedence rule like any other export-vs-research field — the owner's
own value wins over an uncorroborated web claim, and a refused one lands in
`unconfirmed`.
