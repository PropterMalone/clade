---
id: 04-atproto-self-sovereign-identity
name: atproto identity model + social-launch gate
date: 2026-07-17
updated: 2026-07-22
status: active
supersedes: null
commits: [731aa61]
---

# atproto identity model + social-launch gate

**Terms**: *DID* — an atproto Decentralized Identifier (`did:plc:…`), a permanent
cryptographic identity key that survives handle changes. *PDS* — Personal Data
Server, the host holding a user's atproto records (today usually Bluesky-hosted;
can be self-hosted). *The bridge / hold-back* — the persona→real-identity link
(schema.md §5.2), the field that unmasks a pseudonymous contact; never networked.

**Decision** (two parts):

1. **Identity model (roadmap, unbuilt).** If Clade grows a social form, it is
   built on one primitive — a subject's DID-anchored, self-published Clade
   profile — governed by three rules:
   - **Politeness ethos** — honor people by the public self-presentation they
     chose; never dig (no breach data, deep OSINT, scraping, de-anonymizing).
   - **Custody constraint** — a user's data stays under their sole control:
     local, self-hosted, or in private records encrypted at rest such that the
     host cannot read them. A host-readable record on a third party's PDS does
     NOT satisfy this. (Generalizes ADR-01's custody principle to the
     subject-owned-PDS model; ADR-01 itself governs only Clade's local storage.)
   - **Two-layer split** — the public-persona layer (DID/handle, public web
     presence, subject-self-published records) is what networks; the bridge and
     owner-attested facts stay in local custody. Only the subject moves a fact
     across the line, by publishing it themselves.

2. **Launch gate (active now).** Share the **local single-user tool** with
   anyone — it is self-contained and no person-data crosses between users. Do
   **not** launch any social/networked mode (cross-enrichment between users,
   networked bridge propagation, social positioning) until atproto makes its next
   private-data move AND that mechanism, evaluated against the custody constraint,
   passes — i.e. the host cannot read the bridge (whether by encryption at rest,
   self-hosting, or whatever atproto actually ships). Access-control gating that
   still leaves the record host-readable does **not** pass. Don't pin the gate to
   a predicted design; pin it to the constraint and evaluate the real release.
   Today's substrate is public-by-default and cannot represent the scoped
   disclosure (real name to people who've met you, not the public) that Clade's
   pseudonymous seed users — contacts known only by handles — live in.

**Why**: The base product web-researches the owner's own contacts —
nonconsenting *by design*, and correct: a personal rolodex is augmented memory,
not surveillance. So consent-of-the-subject was never the axis; the real axes
are **custody** and **politeness** (the manner of research — meet people at
their front door, don't rifle their bins). The harm to prevent is not *knowing*
a friend's name behind a pseudonym — friends legitimately do — but Clade
becoming the *automated, silent, scalable* vector that unmasks a pseudonymous
person to people who'd never otherwise connect the dots. The self-published
profile is the apex of the ethos: the subject authoring their own public face
outranks any third-party inference, by construction. On the gate: a
public-persona-only launch is containable under the two-layer model but leaves
only *policy* — not the substrate — restraining the pull toward "ID this
handle," has thin value over Bluesky's existing graph, and builds the social
infra twice. Waiting is not idle: the local single-user core is the priority
anchor and must be excellent first, so the gate is correct **sequencing**.

**Rejected alternatives**: (1) Launch a public-persona-only social layer now —
containable under the two-layer model, but dropped for thin value + double-build
+ leaving policy, not substrate, as the only restraint on unmasking. (2) A
centralized Clade profile/account server — reinstates every custody cost ADR-01
exists to avoid and can't offer provable self-sovereign identity.

**Could-be-wrong-if**:
- *Gate freezes the direction*: atproto never ships custody-compatible private
  data, or slips by years. Mitigant: the gate binds only the *networked* layer;
  the local core proceeds regardless. Revisit when BOTH (a) the local core is
  mature — concretely, ≥2 users other than the owner have run the full pipeline
  (ingest→enrich→triage→export) from the README without owner intervention — AND
  (b) atproto's private-data design has landed (or firmed up enough) to evaluate
  against the custody constraint. Its shape also determines *how* the two-layer
  split and bridge-migration get built, so the identity model's mechanism (not
  its principles) stays deliberately unspecified until then — what atproto does
  informs the shape of our move.
  [Grounded: read bluesky-social/atproto#3363 on 2026-07-22 — a tentative,
  uncommitted maintainer design sketch ("namespace" records, gated by DID-based
  access control, same Lexicon system). Critically, that sketch says private
  records are **not encrypted at rest** — host-readable — which is why the gate
  above demands E2EE-at-rest or self-hosting, not mere access control. Unshipped,
  no date; E2EE DMs are a separate mechanism, not sequenced after.]
- *Flywheel can't be made trustworthy*: stale/malicious third-party enrichment
  poisons indexes faster than subject-signed correction + trust-graph weighting
  cleans them. Check in any pilot: correction rate vs. poison rate; threshold:
  poisoning outpaces correction → only the self-published-profile half survives.

**Oriented in code**: `did` is already a first-class, fully-authoritative
resolver identifier and unified entries already carry `dids` (731aa61;
docs/schema.md §3). No networking code exists yet — the launch gate and the
two-layer split are enforced by convention and review today, to become
architectural when the social layer is built.

**How to apply**: While the gate holds — no code that makes one user's Clade
exchange person-data with another's; no networked propagation of the bridge
(schema.md §5.2); ingest and enrich locally only. Owner-attested `realName` is
the bridge and **never networks under any circumstance** — only a genuinely
subject-authored, signed record does; the two are different objects (an owner's
belief vs. a subject's self-disclosure), not the same fact changing address.
When the gate lifts and the social layer is built: public-derived +
subject-self-published are the only shareable classes; anything needing a
host-readable third-party server violates the custody constraint, ADR-01, and
this ADR.
