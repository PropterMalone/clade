---
id: 03-two-surface-claude-as-operator
name: Two surfaces (build vs query) + Claude Code as operator
date: 2026-07-17
status: active
supersedes: null
commits: []  # pre-publication history; not resolvable here
---

# Two surfaces (build vs query) + Claude Code as operator

**Decision**: Clade separates *building* the index (ingest/merge/enrich/triage — done in Claude Code sessions, driven by the CLAUDE.md playbook rather than a fixed CLI/GUI) from *querying* it (done from any plain Claude, including the mobile app, via a `rolodex-knowledge.md` markdown file uploaded to a claude.ai Project). No app, no MCP server, no daemon.

**Why**: The target user does daily lookups on their phone and is often non-technical (the archetype user mostly uses the Claude mobile app, not a terminal). Two consequences: (1) the *query* surface must not require Claude Code at all — so the index exports to Project knowledge and plain mobile Claude becomes the query engine; (2) the *build* surface should be conversational, not a CLI the user operates — so CLAUDE.md is the actual product (Claude parses whatever export is in front of it instead of us maintaining brittle per-platform parsers that break when export formats drift). "Claude Code as operator" also means the interview, merge-review, and triage steps are chat, not forms.

**Rejected alternative**: Ship an MCP server as the primary interface (write-back from any Claude surface). Deferred, not dropped — it's the ergonomic endgame for phone-side capture/write-back and the "just met someone" flow, but it's a running service (a Worker committing to the private repo), which partially breaks the zero-infra local-first premise. Held as a named v2, gated on the re-upload friction actually becoming painful. Also rejected: rigid per-platform parser scripts — export formats drift, and a playbook that says "parse what's there" absorbs that drift for free.

> **Amended 2026-07-25.** The objection above conflates MCP-the-category with MCP-over-HTTP. It holds for a *remote* server (a running service, someone's infrastructure, the whole index reachable off-machine) but not for a **stdio** server, which is a local subprocess reading local disk — no network surface, no infra, no custody change. That distinction reopens the deferred half: `docs/mcp-kit.md` publishes the tool contract for all three deployment classes (local / private-network / public HTTPS) per ADR-07, and `scripts/clade-mcp.mjs` ships a zero-dep stdio reference implementation. Clade still hosts nothing, and the knowledge-file query path is unchanged for phone users. The remote classes are a real custody change, and what sanctions them is privacy rule 2's existing carve-out — "whatever query surface the owner explicitly sets up" — the same clause that already covers uploading `rolodex-knowledge.md` to a claude.ai Project. That carve-out requires the owner to choose it deliberately for their own infrastructure; it is not a general licence to host, and it does not reach hosting anyone else's data. Note also that this ADR's original falsifier (re-upload friction becoming painful enough that the phone copy rots) is what actually motivated the work — the stdio/HTTP distinction reopened the *local* half, but the remote half was always gated on that friction, and it fired.

**Could-be-wrong-if**: the manual re-upload of `rolodex-knowledge.md` after each build session proves so annoying that users stop refreshing their Project and the index goes stale in practice. Check: does the user actually re-export/re-upload after enrichment sessions, or does the phone copy rot? If it rots, the MCP write-back v2 becomes required, not optional.

**How to apply**: Keep the query path dependency-free and phone-reachable (a flat knowledge file, not a service). Keep build steps expressed as playbook prose Claude executes, not as fixed parsers or a CLI the user must learn. New "make it easier to use" proposals should first ask whether they can live in the playbook before they add infrastructure.
