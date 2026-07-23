# Clade

Clade builds a contact rolodex from the data exports the big platforms already
owe you: LinkedIn connections, Facebook friends, Google contacts, phone vCards.
It merges them into one searchable index, then uses web research to fill in who
each person is, what they do, and why you know them.

## Your data is yours

Clade is software you run, not a service you sign up for. There is no server,
no account, no telemetry. Nothing phones home. The author has no role in
hosting any of it and never sees your data. On a local install your contacts
live only on your machine (the data directories are gitignored and never
committed).

Three things can leave your custody, all under your control:

1. Enrichment research by your own agent, through the agent account you
   already have. Web searches are one person per query. The URL-confirmation
   step may batch a few contacts' public profile details (names, employers,
   links, never your private notes about them) into a single session.
2. A knowledge file you can choose to upload to your own claude.ai Project
   for phone lookups.
3. In cloud mode (Claude Code on the web), commits to your own private GitHub
   repo. There, your repo is your storage. See the cloud-mode notes in
   CLAUDE.md.

Nothing needs to stay running. There is no daemon and no sync job. Everything
happens inside a conversation with your agent, and enrichment runs in
resumable batches that stop cleanly when you close the lid.

## What you need

1. **An AI coding agent.** [Claude Code](https://claude.com/claude-code) is
   the tested path, and any paid Claude plan is enough, including the $20 Pro
   plan. Enrichment defaults to a fast model and runs in small resumable
   batches sized to whatever quota you have spare; a bigger plan just means
   bigger batches. Other agent CLIs should also work. The whole "app" is a
   markdown operating manual ([CLAUDE.md](CLAUDE.md), mirrored as
   [AGENTS.md](AGENTS.md) for other agents) plus Node scripts with zero
   dependencies, and the web-research step is pluggable: see
   [Bring your own model](docs/byo-model.md).
2. **Node.js 20+.** No packages to install, no build step.
3. **Your data exports.** Each takes about five minutes to request. Some
   arrive by email a day later.
   - LinkedIn: Settings & Privacy > Data privacy > *Get a copy of your data* > Connections
   - Facebook: Settings > *Download your information* > Friends
   - Google: [takeout.google.com](https://takeout.google.com) > Contacts
   - Anything else with a contact export (phone vCards, Twitter/X archive, ...)

That's the whole stack: an agent, Node, and your own data.

## What it's like

Day one, before your exports even arrive:

```
cd clade
claude
```

> "Get me set up."

The agent interviews you for a short life history: schools, jobs, cities,
with rough years. Ten minutes of conversation. This is what lets it figure
out later that a Facebook friend added in fall 2008 is probably from your
college years.

When the exports land, drop the files in `imports/` and say so:

> "I put my LinkedIn and Facebook exports in imports/."

The agent parses them, builds the index, and asks about people who look like
the same person across sources. Obvious duplicates get one bulk question.
Genuinely ambiguous ones get asked one at a time.

> "Enrich a batch."

Your agent (or your own model) web-researches your contacts, richest data
first, and fills in profession, employer, and expertise. Run a batch whenever
you have spare quota. Stop any time; nothing is lost.

> "Let's triage."

Web research can't identify a Facebook name with no web presence. You can, in
about ten seconds each. The agent serves the leftovers in small batches,
sorted so families cluster, and your short answers ("college roommate",
"cousin", "kickball league") get saved as first-class data. "Cousin" is
exactly what a rolodex should say about someone with no web presence. And if
you have a hunch that a pile of unknowns all come from the same place, cue
mode checks the whole batch against that one hint and brings back an
evidenced yes/unsure/no board for you to confirm.

> "Who do I know in healthcare?"

Ask anything. The agent reads the index and answers, including the fuzzy
multi-hop questions. There is also a CLI for quick lookups:
`node search.mjs healthcare`, `node search.mjs --stats`.

When you meet someone new, jot them in `imports/quickadd.md` (you can edit it
from the GitHub app on your phone right after a meeting) and later say
"process my quick-adds". They get parsed, merged, enriched, and checked
against the people you already know.

## Use it from your phone

You only need a coding agent for building the rolodex. For everyday lookups,
say "export for my Project" and you get a `rolodex-knowledge.md` file to
upload to a claude.ai Project (call it "My Rolodex"). After that the Claude
mobile app answers "who do I know in energy policy?" from anywhere. Re-upload
whenever you've enriched or triaged more contacts.

If you prefer the browser to a terminal, Claude Code also runs at
claude.ai/code against this repo as a private GitHub fork. See the "Cloud
mode" section of CLAUDE.md. Short version: your data persists as commits to
your own private repo, and Claude sets that up for you.

## Where things live

Raw exports go in `imports/`. Everything derived lives in `contacts/` (all
gitignored). The data model is in `docs/schema.md`. The operating manual the
agent follows is `CLAUDE.md`.

## Roadmap

Clade today is a local, single-user tool. Nothing networks, and that is the
whole product right now. The schema carries some forward-looking scaffolding
(atproto identity keys, versioned files) toward a possible future where, with
consent, rolodexes could share only what each person makes public. That layer
is gated and unbuilt, and may never ship.
[docs/roadmap.md](docs/roadmap.md) explains the bones you'll see in the code
and why we won't build the networked layer until the substrate can keep your
data truly private.
