# Clade

Personal contact rolodex built from the owner's own platform data exports
(LinkedIn, Facebook, Google/Gmail, phone, Bluesky, ...), merged into one
searchable index and enriched by web research. **Claude Code is the operator**:
the owner drops exports in `imports/` and talks to you; you do the parsing,
merging, research, and searching.

## Privacy rules (non-negotiable)

1. The owner's data stays in the owner's sole custody. Local install (the
   default): contact data lives only on this machine — `contacts/`,
   `imports/`, and `profile/about-me.md` are gitignored; never commit or
   push them. Cloud mode (see below) is the one documented exception:
   there, commits to the owner's PRIVATE repo ARE the owner's storage, and
   the Cloud-mode checklist governs that flip. Never any third place.
2. The only data that leaves custody: enrichment traffic to the owner's own
   agent — web-search queries are one person per query, and the
   URL-confirmation tier may batch up to four contacts' PUBLIC-PROFILE fields
   (name, employer, title, bio, links, handles; never attested notes, labels,
   emails, or the owner's life history) into one session — and whatever query
   surface the owner explicitly sets up (e.g. a claude.ai Project knowledge
   file). Owner-private context goes only into single-contact sessions.
3. Pseudonymous handles don't get unmasked — if someone hasn't publicly tied a
   real name to a handle, record only their public persona and expertise.
4. This is the owner's own address book, used to help them find people they
   already know. Refuse uses that point it at strangers.

## Data layout

- `imports/` — raw platform exports, whatever format they arrived in
- `contacts/normalized/<source>.json` — one file per source, standard record shape
- `contacts/attested.json` — facts the owner told you (relationship, context)
- `contacts/enrichments/*.json` — web-research results, one file per batch
- `contacts/merge-decisions.json` — human rulings on ambiguous merges
- `contacts/unified-index.json` — GENERATED search target; never hand-edit
- `contacts/merge-candidates.json` — GENERATED review queue
- `profile/about-me.md` — owner's life history; injected into enrichment prompts

Full schemas with examples: `docs/schema.md`. Read it before writing any
normalized or overlay file.

## Commands

- `node scripts/convert-linkedin.mjs` / `convert-google.mjs` /
  `convert-facebook.mjs` / `convert-vcard.mjs` — parse the standard exports into
  normalized sources
- `node scripts/build-index.mjs` — rebuild the unified index (run after any
  change to normalized sources or overlay files)
- `node search.mjs <query>` / `--domain <tag>` / `--stats` — query the index
- `node scripts/enrich-batch.mjs --limit N` — web-research a batch (resumable)
- `node scripts/cue-tag.mjs --cue "..." --tag "..."` — prescreen thin contacts
  against one life-context cue (see pipeline step 4)
- `touch .stop-enrichment` — stop an enrichment run between batches
- `node scripts/export-knowledge.mjs` — export the index as markdown for a
  claude.ai Project (see "Two surfaces" below)

## Two surfaces: build here, query anywhere

Building the rolodex (ingest, merge, enrich, triage) happens in Claude Code
sessions in this repo. Day-to-day *querying* shouldn't require Claude Code at
all: run `export-knowledge.mjs` and upload `contacts/rolodex-knowledge.md` as
knowledge in a claude.ai Project (e.g. "My Rolodex"). Plain Claude — web or
mobile app — then answers "who do I know in X?" anywhere. Re-export and
replace the Project file after each enrichment or triage session; offer this
step proactively whenever a session changes the index.

## Cloud mode (Claude Code on the web)

If the owner works in claude.ai/code (browser) instead of a local machine,
sessions are ephemeral and **git commits to their private repo are the only
persistence** — the default gitignore would silently discard their data
between sessions. In that setup, on first run: confirm the repo is PRIVATE
and owned by them, then remove the data-ignore lines from `.gitignore` (the
block is labeled) so `contacts/`, `imports/`, and `profile/about-me.md` are
committed, and commit data changes at the end of every session. Never make
this flip in a repo that is public or shared.

Sandbox facts (probed 2026-07 on a real claude.ai/code session):

- Nested headless `claude -p` authenticates and runs, but the sandbox runs
  as root, which REJECTS `bypassPermissions`/`--dangerously-skip-permissions`.
  The built-in Claude provider (`scripts/lib/agent.mjs`) therefore uses
  `--allowedTools "WebSearch,WebFetch"` — don't reintroduce bypass mode. (The
  research call is pluggable now — `CLADE_AGENT_CMD` swaps the backend, see
  `docs/byo-model.md` — but the default Claude path is unchanged.)
- Shell egress goes through an allowlist proxy: arbitrary API hosts (e.g.
  Bluesky's public API) are NOT reachable. Live-API ingest is local-only;
  cloud users ingest from uploaded exports, which covers every source except
  live Bluesky.
- WebSearch works in-session and in nested `claude -p`. If script-driven
  enrichment ever misbehaves in the sandbox, the fallback is in-session
  enrichment: do the research yourself with WebSearch/WebFetch and write
  batch files to `contacts/enrichments/` in the exact schema — the rest of
  the pipeline can't tell the difference.

## The pipeline

### 0. First-run setup interview

If `profile/about-me.md` doesn't exist, interview the owner before anything
else: places lived, schools, employers, communities — each with rough years.
Write it to `profile/about-me.md` (template: `profile/about-me.example.md`).
This is the disambiguation prior for every future enrichment: connection dates
cluster by life era, so "Facebook friend added fall 2008" + "was at State U
2005–2009" turns a bare name into a searchable query. Ask follow-ups until the
major eras have employers/schools/cities attached, then render an explicit
"era cheat-sheet" section mapping year-ranges to life chapters.

Interview techniques that matter (each found necessary in practice):

- **Ask specifically about eras that never appear on a resume**: schools left
  without a degree, years between cities, gap years. These are invisible to
  any resume-derived source but are often major friend cohorts.
- **Verify fuzzy dates against the owner's own mailbox** when they have Gmail
  ingested or handy: "night school around 2011-2012 maybe?" pinned to
  2010–2014 by the first and last emails from the school's domain. Memory
  compresses long eras; email doesn't.
- **Online communities produce friends known by handles, not names** (forums,
  gaming). Note these scenes in the prior so triage doesn't misread a
  handle-only contact as unidentifiable.

### 1. Ingest — parse whatever lands in `imports/`

Inspect each export and write `contacts/normalized/<source>.json` per
`docs/schema.md`. Don't build permanent parsers — exports change format; parse
what's actually in front of you (directly for small files, via a throwaway
script for big ones). Keep `sourceId`s stable across re-imports (slug of the
source's own identifier or name), because enrichments and attested facts attach
to `<source>:<sourceId>` keys forever.

**Name trust varies by source — never assume a display name is a real
name.** LinkedIn and Google-contacts names are real-name-grade; Facebook,
Bluesky, and Twitter names are display names (often partial — "first + middle
name" — or pseudonymous or jokes). The resolver already treats name matches as
proposals, but keep the distinction in prompts, triage phrasing, and anything
that searches the web by name.

Known export shapes (verify against the actual file — these drift):

- **LinkedIn** (Settings → Data privacy → Get a copy of your data):
  `Connections.csv` — First/Last Name, URL, Email (usually blank), Company,
  Position, Connected On. Convert with `node scripts/convert-linkedin.mjs`
  (don't hand-parse: the CSV has a free-text preamble before the header, and
  quoted commas — "Acme, Inc." companies, "Barlow, CPA" credentialed names —
  that a naive split silently mangles; the script handles both and files
  credentials as labels).
- **Facebook** (Settings → Download your information): friends file (JSON or
  HTML) — names + friend dates only. Convert with
  `node scripts/convert-facebook.mjs` (reads both formats). Thin by design;
  the life-history prior and owner triage carry this source.
- **Google Takeout**: Contacts as CSV — names, emails, phones, orgs, labels.
  Convert with `node scripts/convert-google.mjs` (don't hand-parse: cells
  hold " ::: "-separated multi-values, and the Labels column leaks
  group-membership strings that must not be mistaken for emails). For Gmail
  itself, the higher-signal move is mining sent-mail headers for frequent
  correspondents; ask before building that (it's a bigger job and needs the
  mbox export).
- **Bluesky**: public API, no export needed —
  `app.bsky.graph.getFollows`/`getFollowers` (paginated), profiles via
  `app.bsky.actor.getProfile` on `public.api.bsky.app`. Bios and links go in
  `bio`/`urls`. **Always store the account's `did`** — handles rotate, the DID
  is the permanent identity key (and the hook for the ADR-04 atproto roadmap).
  Also derive and store `edge` (`mutual`/`following`/`follower`) from presence in
  the follows vs. followers lists — capture it at ingest; it's lost if the
  relationship changes before a later query (schema.md §5.5).
- **Phone/vCard** (`.vcf` — Apple Contacts.app / iCloud "export vCard", Google,
  Outlook): `node scripts/convert-vcard.mjs [file.vcf ...]` (default
  `imports/contacts.vcf`). One `.vcf` holds any number of concatenated cards, so
  a whole address book — the common case is a cmd-A "Export vCard" of thousands
  of contacts — is a single file; pass several to merge address books. The
  converter unfolds RFC-6350 line folding, tolerates Apple `itemN.` prefixes (so
  `item1.EMAIL` parses as EMAIL; pairing the `item1.X-ABLabel` custom label onto
  the value is a follow-up, not yet done), unescapes `\, \; \n`, strips
  `mailto:`/`tel:` schemes, keeps multi-valued email/phone/url, and drops PHOTO
  blobs. Social-profile URLs go into `urls[]` (so they can merge cross-source),
  and a URL that reduces to a non-identifying segment (`facebook.com/profile.php`)
  yields no handle rather than a shared key that would glue strangers. Prefers
  the card `UID` for a stable `sourceId` and de-dups same-UID cards across merged
  files. vCard 2.1 quoted-printable values aren't decoded — re-export as 3.0/4.0
  if fields look garbled (the converter warns).
- **Twitter/X** (Settings → Your account → Download an archive; ~24h wait):
  the WEAKEST source in 2026 — set expectations low before ingesting.
  `data/following.js` / `data/follower.js` are `window.YTD.*` JS wrappers
  containing **account IDs only — no handles, no names** (just
  `accountId` + an `intent/user?user_id=…` link). And the ID→handle bridge is
  effectively DEAD: the old `intent/user` redirect that exposed the handle now
  returns a 200 SPA (resolved client-side, behind login), and the API is
  paywalled — so there is no free, scriptable way to turn those IDs into
  people. Verified 2026-07 on a real archive (1,833 following / 2,770
  followers, all ID-only; intent URL → 200, no redirect).
  What IS salvageable:
  - **DM partners are the high-value slice**: `data/direct-message-headers.js`
    gives the IDs of everyone the owner actually messaged (still ID-only, but a
    small curated set — hundreds, not thousands — of genuinely close contacts
    worth manual resolution or owner triage).
  - **Own tweets carry handles**: `@`-mentions in `data/tweets.js` are real
    handles (not tied to the follow-graph IDs, but a source of known contacts).
  - If the owner has the paid X API or will resolve IDs in a logged-in browser,
    then cross-reference resolved handles against Bluesky (many re-registered
    under the same handle). Absent that, treat the archive as near-unusable for
    automated resolution and don't spend a big enrichment budget on it.

After ingesting: `node scripts/build-index.mjs`, then report counts and
anything odd (empty fields, encoding junk, suspiciously low record counts).

### 2. Merge review

`build-index.mjs` auto-merges people across sources only on strong evidence
(shared email/phone/handle/LinkedIn URL, or near-exact name + same employer).
Ambiguous pairs land in `contacts/merge-candidates.json`, each tagged with a
`reason`:

- `"exact-name"` — identical multi-token name, unique in both sources, no
  employer conflict. In a personal address book these are almost always the
  same person; offer the owner a bulk ruling ("47 exact-name pairs — merge
  them all? I'll list any that look off") rather than one-by-one questions.
- `"fuzzy"` — similar-but-not-identical names. Walk these one at a time
  ("Is gmail's jwilson@ the same person as LinkedIn's Jennifer Wilson at
  Deloitte?").
- `"shared-phone"` / `"shared-email"` — two records with *different* names
  share a number or address. Phones and emails are legitimately shared
  between people (household landlines, couples' inboxes, one number on
  several of the owner's own cards), so these never auto-merge; the
  `identifier` field shows the shared value. Ask which situation it is —
  same person under two names, or two people sharing a line.

Record each ruling in `contacts/merge-decisions.json` (`verdict: "same"` or
`"different"`) and rebuild. **Envelope shape (schema §5.6):** these overlay files
carry a `schemaVersion` wrapper — `merge-decisions.json` is
`{ "schemaVersion": 1, "decisions": [ … ] }` and `attested.json` is
`{ "schemaVersion": 1, "entries": { "<key>": … } }`. Put rulings inside
`decisions` and attested facts inside `entries`; a record key added at the top
level beside `entries` is now rejected loudly (it would otherwise be silently
dropped). A bare legacy file (no wrapper) is still accepted. Rulings are
permanent: a decided pair never resurfaces, and a `different` ruling blocks the
whole person-pair even via third-record bridges (checked live against merge
state, enforced by tests — see `docs/decisions/02`). The build also warns when a shared strong
identifier joins two records whose names share nothing — relay those to the
owner for a quick sanity check.

### 3. Enrich — `node scripts/enrich-batch.mjs --limit N`

Researches contacts via a web-search-capable agent, richest seeds first,
banking results to `contacts/enrichments/`. The agent is **pluggable**
(`scripts/lib/agent.mjs`): Claude Code (`claude -p`) by default — zero config —
or any executable that reads the prompt on stdin and prints text, via
`CLADE_AGENT_CMD` (see `docs/byo-model.md`). Only the research call is the
model; prompt-building, parsing, validation, backoff, and banking are all
model-agnostic. Fully resumable: attempted contacts are never retried, un-banked
ones are first in line next run, so the normal mode is a drip — a batch here and
there across days, sized to whatever quota the owner has spare. Default
`--limit 25 --concurrency 3` is a safe single-session bite; hitting the
provider's usage limit mid-run is expected and stops cleanly.

Token economy (why any paid plan, Pro included, is enough): claude-mode
research runs on a fast model by default (`--model` to override); contacts
that already carry a LinkedIn URL are cheap 1-2-fetch confirms and share a
session in groups of 4 (`planWork` in `enrich-core.mjs`) carrying
public-profile fields only — attested notes, labels, emails, and the
life-history prior never enter a shared session (privacy rule 2's batching
carve-out). Thin contacts run solo with the life-history prior injected; the
search budget is tiered (1-2 fetches for URL-confirms, up to 5 searches for
open research, stop at corroboration). Confirm entries must echo their
contact's LinkedIn URL — mismatches and duplicate `n`s are dropped to retry,
never banked.

Before the first-ever run, confirm `profile/about-me.md` exists (step 0) —
enrichment quality for name-only contacts depends on it.

### 4. Triage — the owner is the best source for thin contacts

For entries still `low`/`unidentified`/`none` after enrichment (Facebook
names especially), present them in conversation for the owner to recognize.
Date-clustering is weaker than it looks: friend dates only cluster for WAVE
years (the owner's platform join wave, a family event); ordinary years mix
every life era, so lead with recognition — batches of ~10 names the owner
tags with short bucket labels — and use dates as a hint, not an organizer.
Serve batches surname-sorted (families cluster), and after the owner answers,
echo the full name-to-tag mapping back before applying — positional answers
misalign silently otherwise. The owner's ten-second answer ("college
roommate's wife", "cousin", "kickball league") goes in
`contacts/attested.json` under the record's key — `relationship`, `context`,
optional `domains`. User-attested facts are first-class: an entry with only a
relationship tag is a success, not a failure ("cousin" is exactly what a
rolodex should say about someone with no web presence). Watch for pseudonymous display names — Facebook names are often "first
name + middle name" ("Jane Em") or joke names hiding a real surname; when the
owner remembers the real name, record it as `realName` in the attested entry
and it overrides the display name across the index. When a cluster of
unrecognized names shares a connection-date range, don't grind through them
one by one — ask "what was happening in your life that year?" first; the
answer usually names a scene that resolves the whole cluster and belongs in
`profile/about-me.md`. After a triage session, rebuild; newly-attested
context also makes those contacts eligible for another enrichment pass.

**Cue prescreen — bang the unknowns against a bucket.** When the owner says
"most of these are probably <scene>", run
`node scripts/cue-tag.mjs --cue "<life context with place + era>" --tag "<label>"`:
each thin contact gets a conservative web check against the cue, and the
yes/unsure/no board (with evidence) goes to the owner to corroborate before
`--apply` writes anything. What to expect, from real use: cues with a
FINDABLE ROSTER hit hardest (a high-school class page turned one run into a
lookup table — 16 confirms, zero misses); small institutions beat big cities;
hometowns without rosters come back mostly "unsure" — that's honesty, not
failure. The owner outranks the web in both directions: a web "no" can be
wrong about which same-named person it found, and an owner "they're X" is
final. Bonus: NO verdicts often *identify* the person anyway, and one cue's
evidence sometimes confirms a different bucket — read the whole board.

### 5. Search

`node search.mjs energy policy`, `--domain law`, `--stats`, etc. For fuzzy or
multi-hop questions ("who do I know in Chicago healthcare?"), read the index
yourself and answer directly — the CLI is for quick lookups, you are the real
query engine.

### 6. Quick-add — "I just met someone"

The batch pipeline above seeds the index; this is how it grows day to day, and
it's the highest-frequency use once seeding is done. The owner captures people
they meet in `imports/quickadd.md` — freeform prose, one person per block,
whatever they know (see `imports/quickadd.example.md`). They can edit that file
straight from github.com on their phone right after a meeting; capture needs no
session, only processing does.

When the owner says **"process my quick-adds"**:

1. Read `imports/quickadd.md`. For each block, extract what's there into a
   `manual`-source record (`contacts/normalized/manual.json`, `source:
   "manual"`, stable slug sourceId). Names known only by a handle are fine —
   put the handle in `handles` and leave `name` as the handle if that's all
   there is.
2. Put the *relationship and context* — how they know this person, who
   introduced them, why they care — into `contacts/attested.json` under the
   record's key. This is first-class data (the owner is the authority on their
   own contacts), and it's usually the most valuable thing captured.
3. Rebuild (`node scripts/build-index.mjs`) and **check the merge output**: a
   just-met person may already be in the index under another source, or share a
   name with someone. Surface likely matches to the owner ("You already have a
   Dave Chen from LinkedIn at a different company — same person?") rather than
   silently merging or silently duplicating.
4. Offer to enrich the new people immediately — one person is a tiny batch:
   `node scripts/enrich-batch.mjs --limit 5`. For someone with a real name +
   employer this usually resolves on the spot.
5. Answer the warm-path question when relevant: on adding someone, "do I
   already know anyone connected to them?" is a read over the existing index,
   and often the point of adding them.
6. Clear the processed blocks from `imports/quickadd.md` (leave a comment noting
   what was processed and when), and offer to re-export the Project knowledge
   file so the phone stays current.

Design note: don't build a rigid parser for quickadd — parse the prose yourself,
the same way you parse exports. The freeform capture IS the feature; a form
would defeat it.

## Conventions

- Node ESM scripts, no dependencies, no build step. Match the existing style.
- Overlay files (attested, decisions, enrichments) are append-mostly and keyed
  by `<source>:<sourceId>` — never rekey them.
- After any data change, rebuild the index before answering questions from it.
- Report enrichment stats honestly per tier: LinkedIn-seeded contacts resolve
  at high rates; Facebook name-only contacts mostly won't — that's what
  triage is for, not a bug.
