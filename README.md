# Clade

Your own contact rolodex, built from the data exports the big platforms already
owe you — LinkedIn connections, Facebook friends, Google contacts, and more —
merged into one searchable index, then enriched by web research so every entry
says who the person is, what they do, and why you know them.

Your contacts stay in your sole custody: on a local install nothing is
committed to git and nothing leaves your machine; in cloud mode (Claude Code
on the web) your data persists as commits to your own private repo — see the
cloud-mode notes in CLAUDE.md.

## What you need

1. **Claude Code** ([install](https://claude.com/claude-code)) with a paid plan —
   Claude does the parsing, merging, and research. A Max plan's spare capacity
   is plenty; enrichment happily runs in small batches over days. Prefer a
   different model? The **web-research step** is pluggable — point Clade at any
   web-capable agent (see [Bring your own model](docs/byo-model.md)). You still
   drive the build by talking to *some* coding agent; only the enrichment model
   is swappable.
2. **Node.js** 20+ (no packages to install — the scripts have zero dependencies).
3. **Your data exports** (each takes ~5 minutes to request; some arrive by
   email a day later):
   - LinkedIn: Settings & Privacy → Data privacy → *Get a copy of your data* → Connections
   - Facebook: Settings → *Download your information* → Friends
   - Google: [takeout.google.com](https://takeout.google.com) → Contacts
   - Anything else with a contact export (phone vCards, Twitter/X archive, ...)

## Getting started

```
cd clade
claude
```

Then just talk to it:

> "Get me set up." — Claude interviews you for a short life history (schools,
> jobs, cities, with years). This is what lets it figure out that a Facebook
> friend added in 2008 is probably from your college years.
>
> "I put my LinkedIn and Facebook exports in imports/." — Claude parses them,
> builds the index, and flags any people it thinks appear in multiple sources.
>
> "Enrich a batch." — Claude (or your own model — see
> [Bring your own model](docs/byo-model.md)) web-researches your contacts
> (richest data first) and fills in profession, employer, and expertise. Fully
> resumable; run it whenever you have spare quota.
>
> "Let's triage." — For the leftovers (Facebook names with no web presence),
> Claude asks you who they are, era by era. "College roommate" is a perfectly
> good answer and gets saved.
>
> "Who do I know in healthcare?" — Ask anything. There's also a CLI:
> `node search.mjs healthcare` or `node search.mjs --stats`.

## Use it from your phone

You only need Claude Code for *building* the rolodex. For everyday lookups,
say "export for my Project" — Claude writes a `rolodex-knowledge.md` file you
upload to a claude.ai Project (call it "My Rolodex"). After that, the Claude
mobile app answers "who do I know in energy policy?" from anywhere. Re-upload
the export whenever you've enriched or triaged more contacts.

Prefer the browser to a terminal? Claude Code also runs at claude.ai/code
against this repo as a private GitHub fork — see the "Cloud mode" section of
CLAUDE.md (short version: your data then persists via commits to your private
repo, and Claude will set that up for you).

## Where things live

Raw exports go in `imports/`. Everything derived lives in `contacts/` (all
gitignored). The full data model is in `docs/schema.md`, and the operating
manual Claude follows is `CLAUDE.md`.

## Roadmap

Clade today is a **local, single-user tool** — nothing networks, and that's the
whole product right now. The schema carries some forward-looking scaffolding
(atproto identity keys, versioned files) toward a *possible* future where, with
consent, rolodexes could share only what each person makes public. That layer is
gated and unbuilt, and may never ship. [`docs/roadmap.md`](docs/roadmap.md)
explains the bones you'll see in the code, the ethos (politeness + custody), and
why we won't build the networked layer until the substrate can keep your data
truly private.
