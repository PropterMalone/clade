# Clade

Clade builds a contact rolodex from the data exports the big platforms already
owe you: LinkedIn connections, Facebook friends, Google contacts, phone vCards.
It merges them into one searchable index, then uses web research to fill in who
each person is, what they do, and why you know them.

## Your data is yours

Clade is software you run, not a service you sign up for. There is no Clade
server, no account, and no telemetry: nothing reports back to the author, who
has no role in hosting any of it and never sees your data. On a local install
your contacts live only on your machine (the data directories are gitignored
and never committed).

Be clear about the limit of that claim — it is about Clade, not about your whole
setup. **Enrichment researches people by asking an AI agent, so the contacts you
enrich are sent to whichever model provider you configure, and that provider
sees them under its own terms.** No amount of "no telemetry" on this end changes
that.

And the details are not yours the way your files are. They belong to other
people, who did not ask to be looked up and were never asked whether an AI
should read about them. That asymmetry is real and the tool cannot resolve it
for you. What it can do is make enrichment a deliberate act instead of a
default, which is why it runs in batches you start by hand rather than
automatically over everyone you know. Telling it "cousin" yourself costs no
research at all and is often the more useful record anyway — though if you later
enrich that person, what you wrote goes into their own research session (never
into a batch shared with other contacts).

Three things can leave your custody, all under your control:

1. Enrichment research, run by your own agent through the account you already
   have — so your model provider sees whatever a batch contains. Web searches
   are one person per query. The URL-confirmation step may batch a few
   contacts' public profile details (names, employers, links, never your
   private notes about them) into a single session.
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

### What enrichment actually costs

Worth knowing before you start, because the number is agent time, not money.
Enrichment researches one contact at a time, except that contacts who already
carry a LinkedIn URL are cheap confirmations and share a session four at a time.
So the unit count depends on your mix:

    work units ≈ (contacts with a LinkedIn URL ÷ 4) + (everyone else)

Two real corpora: a ~4,500-contact index about a third LinkedIn-linked comes to
roughly 0.75 units per contact (so **~7,500 units per 10k contacts**); a
LinkedIn-heavy network runs nearer half that (**~5,000 per 10k**). Figure
somewhere between 2,500 and 10,000 units per 10k contacts depending on how much
of your address book came from LinkedIn.

In wall-clock that is **tens of hours of agent time for a large index**, spread
over days or weeks — not a number you sit and watch. That is the intended shape,
not a limitation: runs are fully resumable, attempted contacts are never
retried, and hitting your plan's usage limit mid-run stops cleanly and picks up
next time. Start with `--limit 25`, run it when you have quota spare, and let it
drip. A few hundred contacts is an evening; ten thousand is a project.

You do not have to enrich everything. Enrichment is what turns "a name" into
"who they are and what they know" — but owner-attested facts (step 4 of the
pipeline: you telling your agent "college roommate's wife") are first-class data
that cost nothing and are often more useful than anything the web knows.

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
`node search.mjs healthcare`, `node search.mjs --location chicago`,
`node search.mjs --stats`.

Addresses come along from the sources that carry them (your vCard and Google
Contacts exports), and they arrive at two grades. The city is searchable and
travels with the rest of the rolodex. The street address does not: no research
prompt, no Project export, no MCP result ever carries it — only your own session
reads it, when you ask for it. Worth knowing the limit: a city plus a full name
is enough for a people-search site to look the street address up, so the coarse
grade is a real reduction in exposure, not a guarantee of none.

When you meet someone new, jot them in `imports/quickadd.md` (you can edit it
from the GitHub app on your phone right after a meeting) and later say
"process my quick-adds". They get parsed, merged, enriched, and checked
against the people you already know.

## Two ways to query it

You only need a coding agent to *build* the rolodex. For everyday lookups
there are two surfaces, and they differ in whether the answer is a snapshot or
live.

**A knowledge file.** Say "export for my Project" and you get a
`rolodex-knowledge.md` to upload to a claude.ai Project (call it "My
Rolodex"). After that the Claude mobile app answers "who do I know in energy
policy?" from anywhere. No setup, and it works on a phone today. It is a
snapshot: re-upload whenever you've enriched or triaged more contacts.

**An MCP server.** Your assistant queries the live index instead of a snapshot
you remembered to refresh. `scripts/clade-mcp.mjs` is a working one — local
stdio, zero dependencies, three read tools (`search_contacts`, `get_contact`,
`contact_stats`) — and registering it with Claude Code is one line:

```sh
claude mcp add clade -- node /abs/path/to/clade/scripts/clade-mcp.mjs
```

It re-reads the index on every call, so a rebuild shows up immediately with no
restart. Point it at your data the way every other script does: run it with
cwd set to your data directory, or set `CLADE_DATA_DIR`.

Reaching a server from your *phone* is a bigger decision, because claude.ai
connectors can only call a public HTTPS endpoint, which puts your address book
on infrastructure strangers can reach. [docs/mcp-kit.md](docs/mcp-kit.md) is
the contract: three deployment classes and what each one costs you in
exposure, the seven things a remote deployment owes your index, and the fields
a server must never serve (street addresses, the pseudonym-to-real-name
bridge, web claims the index refused). Clade doesn't host one for you and the
reference server isn't the canonical build — it's one conforming example.

The contract isn't Clade-specific either. Implement the same three tools over
a CSV, a Notion database, or your own app and you get the same query surface,
no Clade required.

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
