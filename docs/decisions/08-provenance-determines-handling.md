---
id: 08-provenance-determines-handling
name: Provenance determines handling — three origin classes, three egress checks
date: 2026-07-25
status: active
supersedes: null
commits: []
---

# Provenance determines handling

**Decision**: Every fact in the index carries **where it came from**, and origin
determines what may be done with it. Three classes:

| Origin | Exportable | Networkable (ADR-04) | May share a batched session |
|---|---|---|---|
| **Public web** — enrichment, public profiles | yes | with consent | yes |
| **Owner-attested** — what the owner told us | yes | never | no (carries owner context) |
| **Jointly-held** — derived from the owner's private correspondence, transcripts, or call records | **no** | **never, and no consent path exists** | **no** |

Jointly-held facts live in their own overlay (`contacts/interactions/*.json`),
keyed by `<source>:<sourceId>` like every overlay, and are surfaced on the record
as a **nested object — never flattened into plain fields**.

**Why**: The schema already discovered this once, narrowly. `nameSource`
(`raw` | `attested` | `enrichment`) exists because names were the case where
origin changes handling — the `realName` hold-back bridge. That was the first
instance of a general rule, not a special case. Making it general now is cheap;
retrofitting it after interaction data exists is not. Three concrete hazards
motivate the specific rules:

1. **The silent confirm leak.** Confirm-tier enrichment batches four contacts
   into one session because its payload is a public-profile allow-list. If a
   correspondence-derived fact is written into a field already on that list
   (`notes`, `bio`), a routine `--units confirm` run months later ships private
   correspondence to whatever cheap backend is configured. Nothing errors and
   nobody decided it — the field was simply reused.
2. **Silent export.** `export-knowledge.mjs` produces the markdown the owner
   uploads to a claude.ai Project. Facts that reach the index reach that upload
   by default, so a large custody change would happen with no one choosing it.
3. **Second-order disclosure.** ADR-04's two layers are public-persona (may
   network with consent) and hold-back (never networks — but *the subject* may
   publish it themselves). Jointly-held facts fit neither. "Spent fifty minutes
   on infosec, NDA executed" describes a *relationship*: sharing it discloses
   that a confidential relationship exists, what was discussed, and that an
   agreement is in force — and the contact is not the one sharing it. The
   hold-back escape valve cannot apply, because neither party can unilaterally
   publish something that belongs to both. Hence a third layer, strictly
   stronger than hold-back.

Provenance also earns its keep for answer quality, independent of privacy:
"Dana is at HackerOne" carries different weight if LinkedIn said so in 2024,
versus she said so last week, versus a web search inferred it.

**Rejected alternative**: Reuse existing fields plus a documented convention —
write interaction facts into `notes`/`bio` and remember not to let them into
confirm batches or exports. Rejected because the failure is silent and
irreversible: no error, no symptom, and the data is already at a third party by
the time anyone notices. The same reasoning already governs `planWork`, which
keeps the life-history prior out of confirm batches structurally rather than by
convention.

**Could-be-wrong-if**: a jointly-held fact appears where it must not — in
`contacts/rolodex-knowledge.md` after an export, in a confirm-batch prompt, or
in any payload leaving the machine other than a solo-tier enrichment call the
owner authorized for correspondence. Concrete threshold: **one occurrence**,
checkable by grepping an export for a string that exists only in an
`interactions/` file. If flattening ever makes that check impossible to run —
i.e. an interaction-derived value is indistinguishable from a public one in the
index — the nesting rule has already failed and the overlay needs its own
read path rather than a merge step.

**How to apply**:
1. **One marker, four checks.** The origin marker is tested at every egress
   boundary: `planWork` (excluded from confirm payloads), `export-knowledge.mjs`
   (excluded from the knowledge file), **any MCP server built from
   `docs/mcp-kit.md`** — tool responses in every deployment class, and any index
   copy pushed off-machine for a class B/C deployment — and any future networked
   layer (excluded absolutely). Each check is "drop the key," which is only
   possible because the data stays nested. The MCP surface is listed explicitly
   because it is the one that ships *before* the interactions overlay exists and
   travels to third-party implementers without these ADRs: the kit therefore
   carries the rule itself (its "Before you build" §6), and serves an
   allow-list of fields rather than serializing whole records — a blanket
   serialization would start exporting the new field the day it appears.
2. **Never flatten jointly-held facts** into `profession`/`employer`/`domains`/
   `notes`/`bio`. Flattening destroys the only thing the egress checks read.
3. **Correspondence sweeps run solo, never batched** — one contact per session,
   for the same reason the life-history prior does.
4. **Backend eligibility is a separate consent from `CLADE_AGENT_CMD`.** Pointing
   confirms at a cheap third-party model is not consent for that model to read
   correspondence; the sweep requires its own affirmative opt-in naming the
   backend.
5. **This binds before the feature exists.** Content sweeps are unbuilt (ADR-07
   governs *how* — Clade adds no mail connector; the owner's own agent already
   has the access). These rules are the conditions any implementation must meet.
