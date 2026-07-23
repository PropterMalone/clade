// pattern: functional-core
// Provider-seam config + outcome classification (docs/byo-model.md). Pure — no
// spawn, no fs, no env read beyond the object handed in. Shell: scripts/lib/agent.mjs.
//
// Clade's enrichment/cue steps need "an agent that can web-search and loop", not
// a bare LLM. Claude Code is the zero-config default; any other web-capable agent
// drops in as a subprocess that reads the prompt on stdin and prints text on
// stdout (see docs/byo-model.md for the contract).

// Free-text signatures of a throttle/quota failure. Only trusted when the process
// ALSO errored — a bio echoing "rate limit" in a successful response must never
// trip the backoff (angel-review of the original enrich-batch heuristic).
export const LIMIT_HIT_RE =
  /out of (?:extra )?usage|rate.?limit|usage.?limit|too many requests|over(?:loaded|capacity)|\b(?:429|503|529)\b/i

// EX_TEMPFAIL — the explicit "retryable / rate-limited" exit code a custom
// adapter uses to drive Clade's backoff without us guessing from its output.
export const LIMIT_EXIT_CODE = 75

const isPlainString = (v) => typeof v === 'string' && v.length > 0

// CLADE_AGENT_ARGS parsing. A JSON array is preferred (survives args with
// spaces); a plain whitespace-separated string is the simple-case fallback. An
// input that *looks* like a JSON array (`[`) but doesn't parse is a config typo,
// NOT simple args — return null so the shell can warn instead of silently
// whitespace-splitting the raw JSON text into garbage (angel-review).
export function parseArgs(raw) {
  const s = String(raw || '').trim()
  if (!s) return []
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s)
      if (Array.isArray(arr)) return arr.map(String)
    } catch {
      /* fall through to the null signal */
    }
    return null // looked like a JSON array, didn't parse — caller warns
  }
  return s.split(/\s+/)
}

// env: a plain object (typically process.env). Returns the resolved provider.
// No CLADE_AGENT_CMD → the built-in Claude invocation (unchanged from day one).
//
// CLADE_AGENT_MODEL is a hint for CUSTOM adapters only. It is deliberately NOT
// surfaced in claude mode: the default `claude -p …` path must stay byte-identical
// (angel-review — CLADE_AGENT_MODEL set alone used to inject `--model` into the
// default Claude call and break it).
export function resolveAgentConfig(env = {}) {
  if (env.CLADE_AGENT_CMD) {
    const parsed = parseArgs(env.CLADE_AGENT_ARGS)
    return {
      mode: 'custom',
      cmd: env.CLADE_AGENT_CMD,
      args: parsed ?? [],
      argsMalformed: parsed === null,
      model: isPlainString(env.CLADE_AGENT_MODEL) ? env.CLADE_AGENT_MODEL : undefined,
    }
  }
  return { mode: 'claude', cmd: 'claude', args: [], argsMalformed: false, model: undefined }
}

// Map a finished process to { ok, limitHit, limitHitExplicit, text }. `mode` gates
// the free-text heuristic: only the built-in claude adapter (which can't emit exit
// 75) falls back to LIMIT_HIT_RE; custom adapters must signal throttling explicitly.
// `limitHitExplicit` (exit 75) is distinguished so callers can let it win over a
// parseable stdout, while the fuzzy heuristic still yields to a validated result.
export function classifyOutcome({ code, signal, stdout = '', stderr = '' }, mode = 'claude') {
  const ok = code === 0 && !signal
  if (ok) return { ok: true, limitHit: false, limitHitExplicit: false, text: stdout }
  const limitHitExplicit = code === LIMIT_EXIT_CODE
  const limitHit =
    limitHitExplicit || (mode === 'claude' && LIMIT_HIT_RE.test(`${stdout}\n${stderr}`))
  return { ok: false, limitHit, limitHitExplicit, text: stdout }
}

// Redact common secret shapes from adapter stderr before Clade logs it, persists
// it (cue-tag folds stderr into attested `context`), or exports it. A custom
// adapter wrapping an HTTP backend routinely echoes Authorization headers / API
// keys to stderr on failure; without this they would reach disk and the exported
// knowledge file (angel-review — credential-leak vector).
export function redactSecrets(s) {
  return String(s || '')
    .replace(/(authorization\s*:\s*)(?:bearer\s+)?\S+/gi, '$1[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'bearer [redacted]')
    .replace(/\b(?:sk|pk|rk|ghp|xox[baprs])[-_][A-Za-z0-9]{8,}/g, '[redacted-key]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-aws-key]')
    .replace(
      /\b(api[_-]?key|apikey|access[_-]?token|secret|password|passwd|token)(["']?\s*[:=]\s*["']?)[^\s"',&)]+/gi,
      '$1$2[redacted]',
    )
}
