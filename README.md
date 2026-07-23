# Clade

Your own contact rolodex, built from the data exports the big platforms already
owe you — LinkedIn connections, Facebook friends, Google contacts, and more —
merged into one searchable index, then enriched by web research so every entry
says who the person is, what they do, and why you know them.

## Your data is yours — this is software, not a service

Clade is a thing you run, not a thing you sign up for. There is no server, no
account, no telemetry; nothing phones home, and the author has no role in
hosting any of it and never sees your data. On a local install your contacts
live only on your machine (the data directories are gitignored and never
committed). Exactly three things can ever leave your custody, all under your
control:

1. Web-search queries your own agent makes during enrichment (one person's
   name and employer at a time, through the agent account you already have);
2. A knowledge file you may choose to upload to your own claude.ai Project for
   phone lookups;
3. In cloud mode (Claude Code on the web), commits to your own **private**
   GitHub repo — there, your repo is your storage; see the cloud-mode notes in
   CLAUDE.md.

Nothing needs to stay running. There is no daemon, no sync job, no always-on
box: everything happens inside a conversation with your agent, and enrichment
runs in resumable batches that stop cleanly whenever you close the lid.

## What you need

1. **An AI coding agent.** [Claude Code](https://claude.com/claude-code) with a
   paid plan is the tested, first-class path — a Max plan's spare capacity is
   plenty, since enrichment happily runs in small batches over days. Other
   agent CLIs should cope too: the whole "app" is a markdown operating manual
   ([CLAUDE.md](CLAUDE.md), mirrored for other agents as
   [AGENTS.md](AGENTS.md)) plus zero-dependency Node scripts, and the
   web-research step is pluggable — point it at any web-capable model (see
   [Bring your own model](docs/byo-model.md)).
2. **Node.js 20+.** No packages to install, no build step.
3. **Your data exports** (each takes ~5 minutes to request; some arrive by
   email a day later):
   - LinkedIn: Settings & Privacy → Data privacy → *Get a copy of your data* → Connections
   - Facebook: Settings → *Download your information* → Friends
   - Google: [takeout.google.com](https://takeout.google.com) → Contacts
   - Anything else with a contact export (phone vCards, Twitter/X archive, ...)

That's the whole stack: an agent, Node, and your own data.

## What it's like

**Day one — before your exports even arrive.**

```
cd clade
claude
```

> "Get me set up."

The agent interviews you for a short life history — schools, jobs, cities,
scenes, with rough years. Ten minutes of conversation, and it becomes the
disambiguation engine for everything that follows: it's how a bare "Facebook
friend added fall 2008" turns into "probably from your college years."

**When the exports land.** Drop the files in `imports/` and say so:

> "I put my LinkedIn and Facebook exports in imports/."

The agent parses whatever's there, builds the unified index, and asks about
people who look like the same person across sources — one bulk question for
the obvious duplicates, one at a time for the genuinely ambiguous.

**Enrichment, in the background of your life.**

> "Enrich a batch."

Your agent (or your own model — see
[Bring your own model](docs/byo-model.md)) web-researches your contacts,
richest data first, and fills in profession, employer, and expertise. Fully
resumable: run a batch whenever you have spare quota, stop any time, nothing
is lost.

**Triage — the part no other tool does.** Web research can't identify a
Facebook name with no web presence. You can, in about ten seconds each:

> "Let's triage."

The agent serves the leftovers in small batches, sorted so families cluster,
and your short answers — "college roommate," "cousin," "kickball league" — are
saved as first-class data. That's not a consolation prize: *cousin* is exactly
what a rolodex should say about someone with no web presence. And when you
have a hunch ("most of these are probably from my hometown"), cue mode checks
a whole batch of names against that one hint and brings back an evidenced
yes/unsure/no board for you to confirm.

**The payoff.**

> "Who do I know in healthcare?"

Ask anything — the agent reads the index and answers, including the fuzzy,
multi-hop questions. There's also a CLI for quick lookups:
`node search.mjs healthcare`, `node search.mjs --stats`.

**And when you meet someone new**, jot them in `imports/quickadd.md` (editable
from the GitHub app on your phone, right after the meeting) and later say
"process my quick-adds" — they're parsed, merged, enriched, and checked
against the people you already know.

## Use it from your phone

You only need a coding agent for *building* the rolodex. For everyday
lookups, say "export for my Project" — you get a `rolodex-knowledge.md` file
to upload to a claude.ai Project (call it "My Rolodex"). After that, the
Claude mobile app answers "who do I know in energy policy?" from anywhere.
Re-upload whenever you've enriched or triaged more contacts.

Prefer the browser to a terminal? Claude Code also runs at claude.ai/code
against this repo as a private GitHub fork — see the "Cloud mode" section of
CLAUDE.md (short version: your data then persists via commits to your own
private repo, and Claude will set that up for you).

## Where things live

Raw exports go in `imports/`. Everything derived lives in `contacts/` (all
gitignored). The full data model is in `docs/schema.md`, and the operating
manual the agent follows is `CLAUDE.md`.

## Roadmap

Clade today is a **local, single-user tool** — nothing networks, and that's the
whole product right now. The schema carries some forward-looking scaffolding
(atproto identity keys, versioned files) toward a *possible* future where, with
consent, rolodexes could share only what each person makes public. That layer is
gated and unbuilt, and may never ship. [`docs/roadmap.md`](docs/roadmap.md)
explains the bones you'll see in the code, the ethos (politeness + custody), and
why we won't build the networked layer until the substrate can keep your data
truly private.
