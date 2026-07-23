# Bring your own model

Clade's web-research steps — enrichment (`enrich-batch.mjs`) and the cue
prescreen (`cue-tag.mjs`) — call **an agent that can web-search**, not a bare
LLM. By default that agent is Claude Code (`claude -p`), so a Claude user needs
zero configuration. Everything else — parsing, validation, merging, indexing,
search, export — is model-agnostic and never calls a model at all.

To run enrichment on a different backend, point Clade at your own agent with a
couple of environment variables (`CLADE_AGENT_CMD`, optionally `CLADE_AGENT_ARGS`
/ `CLADE_AGENT_MODEL`). Nothing else changes.

## The contract

Your agent is **an executable that reads the prompt on stdin and writes the
response on stdout**:

| | |
|---|---|
| **stdin** | the full prompt (owner life-history + the contact to research). It arrives on stdin, never as an argument — see the privacy note below |
| **stdout** | the agent's text response. Clade extracts a fenced ` ```json ` block from it (the prompt tells the agent exactly which keys to return) |
| **exit 0** | success — but Clade only counts it as a result if a ` ```json ` block parses; an exit-0 run with no parseable block is logged as "no usable result" |
| **exit 75** | retryable / rate-limited → Clade backs off and retries later (`EX_TEMPFAIL`). This wins even if stdout also contains a parseable block, so signal it deliberately |
| **any other non-zero** | failed; the contact is left un-enriched and retried on the next run |
| **env** | your adapter runs with a **minimal** environment — `PATH`, `HOME`, and `CLADE_AGENT_MODEL` (empty string if you didn't set it), not your full shell. Put any API keys your backend needs in the adapter itself or a scoped secrets file, not your interactive shell |

Your agent **must do its own web search** — Clade hands it a research prompt and
reads back text; it does not provide a search tool. A raw chat-completions
endpoint won't browse on its own, so wrap it in an adapter that gives the model a
search tool (or use a provider with server-side web search).

**Privacy notes.** The prompt contains your life history and a contact's details,
so: (1) Clade delivers it on **stdin**, never as a command-line argument (argv is
world-readable via `ps`/`/proc` on shared hosts) — your adapter must not re-forward
it as an argument either; (2) don't let your backend echo secrets to **stderr** —
Clade redacts common shapes (`Bearer …`, `sk-…`, `api_key=…`) before logging or
storing stderr, but redaction is best-effort, not a guarantee.

## Configuration

```sh
export CLADE_AGENT_CMD=./my-adapter.sh        # your executable (chmod +x it)
export CLADE_AGENT_ARGS='["--flag","value"]'  # optional; JSON array preferred (survives spaces)
export CLADE_AGENT_MODEL=gpt-4o               # optional; passed into your adapter's env
```

`CLADE_AGENT_ARGS` also accepts a plain whitespace-separated string
(`--flag value`) for simple cases; a JSON array is safer when an argument
contains spaces. (A `[...]`-looking value that isn't valid JSON is ignored with a
warning rather than silently mis-split.)

`CLADE_AGENT_MODEL` is a hint for **custom adapters only** — it does not affect
the default Claude path. With `CLADE_AGENT_CMD` unset, Clade uses the built-in
Claude invocation: `claude -p <prompt> --output-format text
--allowedTools WebSearch,WebFetch`, plus a claude-mode-only fast-model default
supplied by the calling script (enrich-batch and cue-tag both default to a
fast model there; their `--model` flags override it). Your custom adapter
never receives that claude-mode default — only your own `CLADE_AGENT_MODEL`.

## Example adapter

A minimal adapter that shells out to some hypothetical web-capable CLI. Note the
prompt goes to the backend on **stdin** (never argv), and stderr goes to a
private temp file that's cleaned up:

```sh
#!/usr/bin/env bash
# my-adapter.sh — reads the prompt on stdin, prints the model's text on stdout.
# chmod +x this file, then: export CLADE_AGENT_CMD=./my-adapter.sh
set -euo pipefail
prompt="$(cat)"
err="$(mktemp)"; trap 'rm -f "$err"' EXIT
# your-agent must browse the web and print its answer (including a ```json block).
# Pass the prompt on STDIN, not as an argument (keeps PII out of the process list).
if ! out="$(printf '%s' "$prompt" | your-agent --web-search --model "${CLADE_AGENT_MODEL:-default}" 2>"$err")"; then
  # map your backend's rate-limit signal to exit 75 so Clade backs off
  grep -qiE '429|rate.?limit|quota' "$err" && exit 75
  exit 1
fi
printf '%s\n' "$out"
```

The prompt already instructs the agent to output only a fenced ` ```json ` block
with the exact keys Clade expects, so a well-behaved agent needs no
Clade-specific formatting logic in the adapter — just faithful pass-through of
the model's response.

## Verifying your adapter

```sh
# 0. make it executable (a non-executable adapter fails with `spawn ... EACCES`)
chmod +x ./my-adapter.sh

# 1. does it round-trip a prompt?
echo "Say hello and output a json block: {\"ok\":true}" | ./my-adapter.sh

# 2. one real contact, end to end (needs an index — ingest at least one source
#    and run `node scripts/build-index.mjs` first, or this exits with
#    "No contacts/unified-index.json")
node scripts/enrich-batch.mjs --limit 1
```

A banked result under `contacts/enrichments/` with `confidence: high|medium`
means the adapter works. `unidentified`/`low` for a name-only contact is normal,
not an adapter failure (see the enrichment-stats note in CLAUDE.md). If nothing
banks and you see `no usable result — agent exited 0 but output had no JSON
block`, your adapter ran but didn't emit the fenced ` ```json ` block Clade
needs — check step 1.

## What stays Claude-flavored (and doesn't need to)

- **Query surface.** `export-knowledge.mjs` emits plain markdown; upload it to any
  assistant (a claude.ai Project, or anything else). Model-neutral already.
- **The operator role.** Building the rolodex (merge review, triage, fuzzy search)
  is done by conversing with a coding agent. Any capable agent can drive the
  scripts; only the *quality* of triage and fuzzy search varies by model.
