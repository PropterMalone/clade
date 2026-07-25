# Decision records

Architecture/business-logic decisions for Clade, newest-relevant first. Each ADR
captures what was decided, why it wasn't trivial, what was rejected, and what
would prove it wrong. Format: one screen each; longer than that means it's a
design doc, not a decision record.

- [01 — Local-first, export-driven custody](01-local-first-export-driven-custody.md) — the foundational bet: no OAuth into live accounts; ingest data exports; data stays on the user's machine.
- [02 — Conservative entity resolution](02-conservative-entity-resolution.md) — auto-merge only on strong/unique signals; escalate ambiguity to human ruling. False merge is worse than missed merge.
- [03 — Two surfaces + Claude Code as operator](03-two-surface-claude-as-operator.md) — build in Claude Code (playbook, not CLI), query from any plain Claude incl. mobile (a knowledge file, not an app/MCP).
- [04 — atproto identity model + social-launch gate](04-atproto-self-sovereign-identity.md) — the "if it grows" identity model (DID-anchored self-published profiles, politeness ethos, two-layer public-persona/local-bridge split) **plus the active gate**: share the local single-user tool now; do not launch any social/networked mode until atproto ships custody-compatible private data (encrypted at rest against the host, or self-hosted).
- [05 — Pluggable agent provider](05-pluggable-agent-provider.md) — only the web-research call is the model; any executable that reads a prompt on stdin and prints text can be the backend (`CLADE_AGENT_CMD`).
- [06 — CLADE_DATA_DIR](06-clade-data-dir.md) — one pure seam (`scripts/paths.mjs`) resolves every built-in data path, so a Clade-cwd session can drive data ops against a private data dir outside the public repo.
- [07 — Publish the seam](07-publish-the-seam.md) — at every boundary Clade doesn't control (model, data location, consuming client, content access) it publishes a contract and at most a non-canonical reference implementation; it owns no connections, credentials, or hosted state.
- [08 — Provenance determines handling](08-provenance-determines-handling.md) — every fact carries its origin; three classes (public-web / owner-attested / jointly-held) drive three egress checks. Correspondence-derived facts never export, never network, never share a batched session.
