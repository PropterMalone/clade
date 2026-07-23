# Decision records

Architecture/business-logic decisions for Clade, newest-relevant first. Each ADR
captures what was decided, why it wasn't trivial, what was rejected, and what
would prove it wrong. Format: one screen each; longer than that means it's a
design doc, not a decision record.

- [01 — Local-first, export-driven custody](01-local-first-export-driven-custody.md) — the foundational bet: no OAuth into live accounts; ingest data exports; data stays on the user's machine.
- [02 — Conservative entity resolution](02-conservative-entity-resolution.md) — auto-merge only on strong/unique signals; escalate ambiguity to human ruling. False merge is worse than missed merge.
- [03 — Two surfaces + Claude Code as operator](03-two-surface-claude-as-operator.md) — build in Claude Code (playbook, not CLI), query from any plain Claude incl. mobile (a knowledge file, not an app/MCP).
- [04 — atproto identity model + social-launch gate](04-atproto-self-sovereign-identity.md) — the "if it grows" identity model (DID-anchored self-published profiles, politeness ethos, two-layer public-persona/local-bridge split) **plus the active gate**: share the local single-user tool now; do not launch any social/networked mode until atproto ships custody-compatible private data (encrypted at rest against the host, or self-hosted).
