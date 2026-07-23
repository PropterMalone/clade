# Clade data schema

Three layers: **normalized sources** (what ingestion produces), **overlay files**
(enrichments, attested facts, merge decisions), and the **unified index** (what
`scripts/build-index.mjs` generates and `search.mjs` queries). The unified index
is always regenerable — never hand-edit it.

## 1. Normalized source files — `contacts/normalized/<source>.json`

One file per source (`linkedin.json`, `facebook.json`, `gmail.json`,
`google-contacts.json`, `bluesky.json`, `vcard.json`, `phone.json`, ...). Produced by parsing
whatever raw export landed in `imports/`. Shape:

```json
{
  "schemaVersion": 1,
  "source": "linkedin",
  "importedAt": "2026-07-16",
  "records": [
    {
      "sourceId": "jane-wilson-deloitte",
      "name": "Jane Wilson",
      "emails": ["jwilson@example.com"],
      "phones": [],
      "employer": "Deloitte",
      "title": "Senior Manager, Strategy",
      "urls": ["https://www.linkedin.com/in/janewilson"],
      "handles": {},
      "bio": "",
      "labels": [],
      "connectedOn": "2019-10-04",
      "notes": ""
    }
  ]
}
```

Rules:
- Every record needs `sourceId` (stable + unique within the source file; slug of
  name plus a disambiguator is fine) and at least one of `name` / `emails` /
  `handles`. Everything else is optional — omit empty fields freely.
- `handles` is a map of platform → handle, e.g. `{"bluesky": "jane.bsky.social"}`.
- `did` (optional): the contact's atproto DID (`did:plc:...`), when a source
  knows it. Handles rotate; the DID is the stable identity key and merges with
  full authority. This is the anchor the ADR-04 roadmap (self-published Clade
  profiles, cross-enrichment) keys on — populate it whenever ingesting from
  atproto surfaces.
- `edge` (optional, social-graph sources): `"mutual"` / `"following"` /
  `"follower"` — your relationship to the contact in the source's follow graph.
  Capture it **at ingest**; it's only re-derivable while the follow relationship
  is unchanged (§5.5). `build-index.mjs` folds the strongest edge across a merged
  person onto the unified entry.
- `schemaVersion` (top-level, integer, currently `1`): stamped by the converters
  so a future migrator can detect and upgrade older data (§5.6). Readers key on
  `records`, so it's a non-breaking sibling.
- `connectedOn` (ISO date, when known) matters more than it looks: friend/connect
  dates cluster by life era and drive triage ordering and enrichment context.
- Preserve source richness in `bio` / `notes` rather than dropping it.

A record's **key** is `<source>:<sourceId>` (e.g. `linkedin:jane-wilson-deloitte`).
Keys are how the overlay files below attach data, so they must stay stable across
re-imports — re-parsing the same export must yield the same sourceIds.

#### The `manual` source (quick-add / just-met)

People you add by hand — someone you just met, a contact who lives in no export —
live in `contacts/normalized/manual.json` with `source: "manual"`, exactly the
same record shape. Because there's no re-generatable export behind them, their
records are the source of truth: don't overwrite them on a rebuild. Assign a
stable slug sourceId (`dave-chen-solar`) and keep it.

Quick-add capture (`imports/quickadd.md`) is the freeform front-end to this
source: the owner jots people in prose, Claude parses each into a `manual`
record (plus an `attested.json` entry for the relationship/context — see below),
dedupes against the existing index, and clears the processed text. See the
"Quick-add" section of CLAUDE.md for the flow.

## 2. Overlay files

### `contacts/enrichments/*.json` — web-research results

Written by `scripts/enrich-batch.mjs` (one file per batch). A `schemaVersion`
envelope wraps the record-key map (§5.6); readers tolerate a bare un-wrapped map
too, so a hand-written fallback batch works either way:

```json
{
  "schemaVersion": 1,
  "entries": {
    "linkedin:jane-wilson-deloitte": {
      "realName": "Jane Wilson",
      "profession": "Strategy consultant",
      "employer": "Deloitte",
      "expertise": ["healthcare strategy", "m&a"],
      "linkedinUrl": "https://www.linkedin.com/in/janewilson",
      "confidence": "high",
      "notes": "Confirmed via LinkedIn + Deloitte bio page.",
      "enrichedAt": "2026-07-16T14:00:00Z"
    }
  }
}
```

`confidence`: `high` | `medium` | `low` | `unidentified`. Later files win when
the same key appears twice. The union of keys across all files is the
"already attempted" set — the enrichment driver never re-attempts a key.

### `contacts/attested.json` — facts the user supplied directly

User-attested facts outrank web research (you know who your cousin is; Google
doesn't). Same `schemaVersion` envelope over a record-key map (§5.6); readers
tolerate a bare map, so a hand-written triage edit works either way:

```json
{
  "schemaVersion": 1,
  "entries": {
    "facebook:jennifer-wilson-2009": {
      "relationship": "college roommate's wife",
      "context": "Met at Northwestern ~2008; lives in Chicago",
      "domains": ["nursing"],
      "realName": ""
    }
  }
}
```

All fields optional. `relationship` and `context` are free text; `domains` fold
into the entry's searchable tags. `realName` here is a hold-back bridge — it
overrides the display name locally but never networks (§5.2).

### `contacts/merge-decisions.json` — human rulings on ambiguous merges

`build-index.mjs` auto-merges only on strong evidence and writes the ambiguous
middle to `contacts/merge-candidates.json` for review. Rulings go here, under a
`schemaVersion` envelope over the array (§5.6); a bare legacy array still reads:

```json
{
  "schemaVersion": 1,
  "decisions": [
    { "keys": ["gmail:jwilson", "facebook:jennifer-wilson-2009"], "verdict": "same" },
    { "keys": ["linkedin:john-smith-ibm", "facebook:john-smith-1987"], "verdict": "different" }
  ]
}
```

`same` forces a merge; `different` suppresses the pair from auto-merge and from
future candidate lists.

## 3. Unified index — `contacts/unified-index.json` (generated)

Array of person entries:

```json
{
  "id": "jane-wilson",
  "name": "Jane Wilson",
  "nameSource": "raw",
  "keys": ["linkedin:jane-wilson-deloitte", "gmail:jwilson"],
  "sources": ["linkedin", "gmail"],
  "dids": [],
  "edge": null,
  "emails": ["jwilson@example.com"],
  "phones": [],
  "handles": {},
  "urls": ["https://www.linkedin.com/in/janewilson"],
  "linkedinUrl": "https://www.linkedin.com/in/janewilson",
  "profession": "Strategy consultant",
  "employer": "Deloitte",
  "domains": ["healthcare strategy", "m&a"],
  "roles": ["senior manager, strategy"],
  "labels": [],
  "bio": "",
  "notes": "Confirmed via LinkedIn + Deloitte bio page.",
  "connectedOn": { "linkedin": "2019-10-04" },
  "tier": "multi-source",
  "confidence": "high",
  "attested": null,
  "enrichment": { "confidence": "high", "enrichedAt": "2026-07-16T14:00:00Z" }
}
```

- `tier`: `multi-source` when merged across sources, else `<source>-only`.
- `confidence`: enrichment confidence, or `attested` when the only identity
  information is user-attested, or `none`.
- `nameSource`: `raw` | `attested` | `enrichment` — where the display `name`
  came from. `attested`/`enrichment` mean the name rode in on a `realName`
  bridge (hold-back; a future networked build excludes it mechanically, §5.3).
- `edge`: strongest social-graph tie across the merged person
  (`mutual`/`following`/`follower`), or `null` when no source carries one (§5.5).
- `id` is unique within one build but NOT stable across builds — always use
  `keys` for durable references.

## 4. Life-history prior — `profile/about-me.md`

Free-form markdown autobiography (schools, employers, cities, communities, with
years). Injected into every enrichment prompt so name-only contacts get era
context, e.g. "friended on Facebook in fall 2008" + "I was at Northwestern
2004–2008" → search for the name + Northwestern. See
`profile/about-me.example.md` for the template.

## 5. Forward-compatibility conventions (set before multi-user sharing)

Clade ships now as a **local single-user tool**; a networked/atproto layer is
gated (ADR-04; timing uncertain — it may never ship). Set these conventions
*before* the tool goes to other users: implementing them once now is nearly free
(there is no legacy data to migrate yet), whereas retrofitting them later across
many users' independent datasets is the expensive path. They aim to make data
written now lift into a future atproto layer with **minimal migration** —
`schemaVersion` (§5.6) is the hedge for whatever the still-unspecified
private-data lexicon actually requires.

1. **Shareability is field-level, not file-level.** The three storage layers are
   a *first signal* of provenance — `attested.json` is owner custody (hold-back
   by default); `enrichments/*` and `normalized/*` lean public — but the
   boundary is **per field**, because two traps make the file-level shortcut
   wrong:
   - `normalized/*` records carry owner-collected *private* identifiers (emails,
     phones from Google/vCard) and freeform `notes` (quickadd confided context).
     Not public-persona data.
   - `enrichments/*.json` has its own `realName` field, populated by automated
     web research. A web-resolved pseudonym→real-name link is an unmasking bridge
     (§5.2), not shareable — despite living in the "public" layer.

   Public-persona (networkable) is a **whitelist**: `did` / `handles` / `urls` /
   `bio` and subject-self-published records. Everything else — emails, phones,
   `notes`, any `realName`, relationship/context — is hold-back until a per-field
   ruling says otherwise.

2. **The `realName` bridge is hold-back — in every file it appears.** `realName`
   in BOTH `attested.json` (owner-recalled) and `enrichments/*.json`
   (web-resolved) is the persona→real-identity bridge that unmasks a pseudonymous
   contact. It stays in local custody and is **never propagated** by any
   networked feature. Because the field name collides across a hold-back file and
   a nominally-public one, shareability here rides an explicit rule, not the field
   name — do not let a migrator trust `realName` as public anywhere. (Per ADR-04,
   owner-authored `realName` never networks at all; only a subject-authored,
   signed record ever could.)

3. **Derived / linkage artifacts are never shareable wholesale.**
   `contacts/unified-index.json` and its `rolodex-knowledge.md` export are
   owner-facing convenience artifacts, NOT a networked-feature data source.
   `foldGroup` in `scripts/lib/resolve.mjs` folds `attest.realName` into the
   top-level `name` field and merges `attest.domains` into the shared `domains`
   array — hold-back data smeared into general fields, untagged. A future
   networked build must re-derive the public payload from convention 1's
   whitelist, per field — never publish the merged index by stripping the
   `attested` key. `contacts/merge-decisions.json` is also hold-back: a `"same"`
   ruling asserts a public identity and a pseudonymous one are the same person —
   structurally the same bridge as `realName`. **Wired:** `foldGroup` now emits
   `nameSource: "enrichment"|"attested"|"raw"` on every unified entry, so a
   networked build can exclude bridge-derived names mechanically rather than by a
   rule someone must remember.

4. **`did` is mandatory-when-known, and durable.** For any atproto-sourced
   contact, populate `did` and never drop it across re-imports. Handles rotate;
   the DID is the permanent identity key and the future network's join key (how
   your record of a person and another user's record of the same person are
   recognized as one). It is the **public-persona** key — networkable — as
   distinct from the `realName` bridge, which is not.

5. **Record the graph-edge type.** Social-graph sources (Bluesky, …) should carry
   an `edge` on each record: `"mutual"` (you follow each other), `"following"`
   (you follow them), or `"follower"` (they follow you). It is *intended* to drive
   triage weight (a mutual is a stronger tie) and to keep the politeness
   distinction (someone you follow but have never met is nearer a stranger —
   lighter-touch enrichment). Capture it **at ingest**: it is only re-derivable
   from the live graph while the follow relationship is unchanged — an unfollow
   between ingest and a later query silently loses the historical edge. **Wired:**
   `edge` is documented in §1's record shape and `foldGroup` (`scripts/lib/resolve.mjs`)
   folds the strongest edge across a merged person onto the unified entry. Ingest
   still must *write* it — the Bluesky ingest step (by-hand via the public API)
   sets `edge` per CLAUDE.md's Bluesky notes.

6. **Stamp `schemaVersion`.** Every file should carry `schemaVersion` (integer,
   start at `1`) so a future migrator can detect and upgrade older data.
   Attachment differs by shape and must be explicit — the overlay files can't
   take a bare sibling key:
   - `normalized/<source>.json` — already a top-level object; add
     `"schemaVersion": 1` beside `source`/`importedAt`.
   - `enrichments/*.json`, `attested.json` — flat maps keyed by record key; wrap
     as `{ "schemaVersion": 1, "entries": { "<key>": {…} } }`.
   - `merge-decisions.json` — a bare array; wrap as
     `{ "schemaVersion": 1, "decisions": [ … ] }`.

   **Wired:** `scripts/lib/envelope.mjs` is the single source of truth
   (`SCHEMA_VERSION`, `stampSource`, `wrapEntries`/`unwrapEntries`,
   `wrapDecisions`/`unwrapDecisions`). The three `convert-*.mjs` scripts stamp the
   `normalized/*` files they produce; `enrich-batch.mjs` and `cue-tag.mjs` wrap
   what they write; `build-index.mjs` and the readers unwrap. Readers accept a
   bare hand-written `attested.json` / `merge-decisions.json` (un-versioned legacy
   shape), so migration is zero-cost — but they **fail loud** (exit with the
   filename) on a *malformed* wrapped file rather than silently building a smaller
   index: a typo'd payload key, an `entries`/`decisions` of the wrong type, a
   record key stranded outside `entries`, or a `schemaVersion` newer than the
   build. Two gaps to know: `manual.json` is written by the operator (quick-add),
   not a converter, so it is not auto-stamped (harmless — a normalized
   `schemaVersion` is a sibling readers ignore); and `wrapDecisions` is only used
   on the read/round-trip side — no script *writes* `merge-decisions.json`, it's
   operator-authored, so its envelope is a convention, not code-enforced.

7. **Keep shareable records lexicon-friendly.** `normalized` + `enrichment`
   records stay flat, typed, and free of machine-local assumptions (no absolute
   paths, no host-specific ids); reference people by `did` where available.
