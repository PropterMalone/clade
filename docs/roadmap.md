# Roadmap — and why the schema has atproto bones

**Clade today is a local, single-user tool.** That is the whole product right
now: you point it at your own exports, it builds you a private rolodex, nothing
networks, and your contact data never leaves your machine (the only thing that
does is a web-search query per contact during enrichment — one person's
name/employer at a time). If that's all Clade ever is, it stands on its own.

If you read the code or `docs/schema.md`, you'll notice scaffolding that points
past a local tool — `did` (atproto identity keys) stored on contacts, an `edge`
field for follow-graph ties, `schemaVersion` envelopes on every file, a
`nameSource` tag marking where a display name came from, and language about
"hold-back" fields and a future "networked" layer. This document exists so those
bones aren't a mystery. Here's what they're for and what we will and won't do.

## The possible future: a social form built on atproto

Clade *might* someday grow a social form — where, with consent, your rolodex and
a friend's could recognize the same person and share **only** what each person
has chosen to make public. If that is ever built, it rests on one primitive: a
person's own **DID-anchored, self-published profile** (atproto's
[Decentralized Identifier](https://atproto.com/guides/identity) — a permanent
identity key that survives handle changes). Three rules govern it:

- **Politeness.** Honor people by the public face they chose. No breach data, no
  deep OSINT, no scraping to unmask anyone.
- **Custody.** Your data stays under your sole control — local, self-hosted, or in
  records encrypted so the host itself can't read them. A record sitting readable
  on someone else's server does not count.
- **Two layers.** Only public-persona data (a DID/handle, a public web presence,
  what a person self-publishes) could ever network. The sensitive link — the
  one that ties a pseudonymous handle to a real name — **never** does. Only the
  subject themselves moves a fact across that line, by publishing it.

## The gate: why it isn't built yet (and may never be)

We will **not** build any networked/social mode until atproto ships private data
that satisfies the custody rule above — specifically, private records the host
*cannot read* (by encryption at rest, self-hosting, or whatever atproto actually
delivers). As of mid-2026 it doesn't: the [sketched private-data
design](https://github.com/bluesky-social/atproto/issues/3363) is
access-controlled but **host-readable**, which isn't good enough. It's unshipped
and undated, and it may slip for years or never land.

That's a deliberate gate, not a stall. The local single-user tool is the
priority and has to be excellent first. The forward-compat bones cost almost
nothing to add now while there's no data to migrate, and they mean that *if* the
gate ever lifts, your existing rolodex lifts into the new layer cleanly instead
of forcing a painful migration. If the gate never lifts, they're cheap unused
insurance — nothing about the local tool depends on them.

## What this means for you, using Clade today

- **Nothing networks.** No Clade instance talks to another. Your contacts, the
  merges you rule on, the facts you attest — all local, all yours.
- **The unmasking link never leaves your machine.** A `realName` you record for a
  pseudonymous contact (or one that web research infers) is "hold-back" data by
  design — it's yours to use locally and is never propagated anywhere, even if a
  social layer is someday built.
- **Your data is your storage.** On a local install nothing is committed to git;
  in cloud mode it lives in *your* private repo. See `CLAUDE.md` for the custody
  rules the operator follows.

The full rationale, rejected alternatives, and the exact conditions for
revisiting the gate are in
[`docs/decisions/04-atproto-self-sovereign-identity.md`](decisions/04-atproto-self-sovereign-identity.md).
