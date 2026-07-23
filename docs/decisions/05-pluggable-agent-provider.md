---
id: 05-pluggable-agent-provider
name: pluggable web-research agent (bring-your-own-model)
date: 2026-07-23
status: active
supersedes: null
commits: [6058d1c, 56a2b4f]
---

# Pluggable web-research agent (bring-your-own-model)

**Decision**: The one model-touching step in Clade — web-research enrichment
(`enrich-batch.mjs`) and the cue prescreen (`cue-tag.mjs`) — goes through a
pluggable **agent provider** behind `scripts/lib/agent.mjs`'s `runAgent`. The
provider contract is a **subprocess that reads the prompt on stdin and prints the
agent's text on stdout** (exit 0 = ok, exit 75 = retryable/rate-limited, other
non-zero = failed). Claude Code is the zero-config default; any web-capable agent
drops in via `CLADE_AGENT_CMD`. First-class in-repo HTTP model adapters are
**deferred** (Tier 2).

**Why**: Clade was built on Claude, but public release needs bring-your-own-model
(an early user asked to run it against self-hosted models). The whole
deterministic core (ingest, merge, index, search, export) was already
model-agnostic — coupling was exactly two identical `execFile('claude', …)` sites.
The load-bearing subtlety: these call **an agent that web-searches and loops**,
not a bare LLM, so the seam abstracts *an agent* (which owns its own search loop),
not a chat-completions client. Chosen as a subprocess rather than an in-process JS
interface because Clade ships to friends on varied stacks — a subprocess lets the
backend be Python, a shell script, anything. Because the adapter is
owner-configured (often third-party) code that talks to the internet, the
pre-public /angel gate hardened the boundary: the custom child gets a **minimal
env** (PATH/HOME/CLADE_AGENT_MODEL, not the full shell), adapter **stderr is
secret-redacted** before Clade logs/persists/exports it, and the prompt (owner
PII) travels on **stdin, never argv**.

**Rejected alternative**: (1) An in-process JS provider interface (drop in a `.mjs`
implementing an interface) — more efficient, but forces every backend to be
JavaScript and can't wrap a Python/shell/binary agent, defeating the
varied-stack goal. (2) Ship built-in HTTP model adapters now (OpenAI/Ollama with a
Clade-owned web-search tool loop) — dropped for launch because it makes Clade own
a search-tool loop + provider auth + a tool-calling loop, and a ~10-line
stdin/stdout adapter already covers any backend. Deferred, not refused.

**Could-be-wrong-if**: (a) BYO adoption never materializes — no non-Claude adapter
is used across ~6 months of public availability (check: issues/PRs/community
adapters; threshold: zero) — then the seam was speculative complexity over the
original hardcoded call. (b) The stdin/stdout adapter proves too high-friction and
≥3 users ask for a built-in OpenAI/Ollama provider — then Tier 2 was wrongly
deferred and should ship.

**How to apply**: Any code invoking the enrichment/cue model call routes through
`runAgent` — never spawn `claude` (or any model CLI) directly. A caller passes
`model` only when the user explicitly set it (a hardcoded default would clobber a
custom adapter's `CLADE_AGENT_MODEL`); a claude-mode-only fast default goes via
`claudeModelDefault`. Custom adapters always receive the minimal env and
redacted-stderr treatment; never widen the custom-mode env to the full parent
environment. `CLADE_AGENT_MODEL` is a custom-adapter hint only and must not alter
the default Claude invocation.
