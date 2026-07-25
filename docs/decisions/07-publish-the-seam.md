---
id: 07-publish-the-seam
name: Publish the seam — Clade owns contracts, not connections
date: 2026-07-25
status: active
supersedes: null
commits: []
---

# Publish the seam — Clade owns contracts, not connections

**Decision**: At every boundary where Clade meets something it doesn't control —
a model, a storage location, a consuming client, a source of the owner's own
content — Clade publishes a **contract** and ships at most a *reference*
implementation marked non-canonical. It does not own, host, authenticate, or
maintain what sits on the other side. Five instances, four shipped:
`CLADE_AGENT_CMD` (model), `CLADE_DATA_DIR` (data location, ADR-06), the `file:`
dep + `exports` map (engine/instance), `docs/mcp-kit.md` (query surface), and —
when built — content access for interaction sweeps, where the owner's agent
already has whatever mail/transcript connection they use and Clade adds none.

**Why**: Three constraints already in force converge on this, so it is less a new
principle than a name for one the repo kept rediscovering. (1) **Zero runtime
deps** is load-bearing for `file:`-symlink consumers — a connector SDK in
`dependencies` breaks every private instance. (2) The **parse-what's-in-front-of-you**
ingest doctrine exists because export formats drift; mail APIs, transcript
vendors, and MCP clients drift faster and are more numerous. (3) **Custody**:
owning a connection means holding either a credential or the data behind it, and
both break privacy rule 1. A fourth reason is commercial rather than technical,
and is **narrower than it first looks**: selling hosting over fully-published
open source is a common and viable pattern in general — what it sells is not
having to operate the thing. That value is near zero *here specifically*,
because the thing to operate is a local subprocess over a file (class A has no
ops burden to relieve), and the one class with real ops burden (C, a public
endpoint) is the class whose burden is inseparable from the custody problem. So
for this product a hosted layer would be selling convenience that the kit itself
mostly eliminates, which puts a thumb on the scale toward writing the kit worse.
That is a claim about Clade's shape, not an economic law.

**Rejected alternative**: Ship connectors and/or a hosted service — a Gmail
OAuth ingest, a maintained MCP endpoint, a Fireflies client. Rejected on all
three constraints plus economics: N providers × format drift is unbounded
maintenance for a zero-dep project; a hosted index is the one layer whose value
falls as the published contract improves; and both put the owner's data or
credentials somewhere Clade controls. The layers that *do* get better as the kit
gets better — enrichment quality, the interaction-history layer, paid build work —
remain open.

**Could-be-wrong-if**: (a) **A seam leaks** — any code path where Clade stores a
third-party credential (an API key, an OAuth token) or persists data it did not
derive from files the owner already had. Concrete threshold: one such path;
observable as a new `CLADE_*` variable holding a secret rather than a command, or
any network write outside the enrichment web-search call. (b) **A seam is too
thin to cross** — an owner cannot complete a task because the contract assumes a
capability their setup lacks and Clade offers no path at all. Concrete signal:
the content sweep ships and its most common failure is "my agent can't read my
mail," with no documented remedy. That would justify one thin optional adapter,
not a suite of connectors. (c) **The commercial premise is wrong** — rules 4 and
5 rest on it and the three technical constraints do not reach them, so it needs
its own falsifier: either a hosted layer over the fully-published kit
demonstrably sustains paid demand (someone builds it and people pay, kit and
all), or we catch ourselves withholding kit content to protect something we
sell. The first refutes the premise; the second confirms the incentive it
predicts and means rules 4–5 stopped being descriptive. If (c) fires, demote
rules 4 and 5 from binding tests to heuristics and leave rules 1–3 standing —
they follow from the technical constraints alone.

**How to apply** — binding on every new integration:
1. **Contract first, reference second.** Publish the interface (tool names,
   payload shapes, invariants, failure modes). A reference implementation is
   optional, must be zero-dep, and must say in its header that the contract is
   normative and it is not (`scripts/clade-mcp.mjs` is the model).
2. **No credentials, no OAuth, no hosted state.** `CLADE_*` variables name
   commands and paths, never secrets. If a boundary seems to need a secret, the
   owner's own tooling holds it and Clade talks to that tooling.
3. **Don't privilege our own deployment.** What the authors happen to run gets
   one line of disclosure, not a worked example the alternatives don't get. Doc
   ordering teaches: self-host is the spine, hosted options are peers.
4. **Publish complete.** No section withheld because it is "the product." A
   section that would be embarrassing to publish is a signal the wrong layer was
   chosen to sell, not a signal to hold the section back.
5. **The commercial test** for anything built on top: *does this get worse if the
   kit gets better?* If yes, it is the wrong layer.
