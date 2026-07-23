// pattern: imperative-shell
// Runs the configured agent provider for one prompt (docs/byo-model.md).
// Pure config/classification lives in agent-core.mjs; this file only spawns.
//
// Default (no CLADE_AGENT_CMD): the built-in `claude -p` invocation, byte-identical
// to Clade's original enrichment call. Custom: any executable that reads the prompt
// on stdin and prints the agent's text response on stdout (exit 0 = ok, exit 75 =
// retryable/rate-limited, other non-zero = failed).

import { execFile, spawn } from 'node:child_process'
import { classifyOutcome, redactSecrets, resolveAgentConfig } from './agent-core.mjs'

// The claude-mode child inherits the parent environment (it needs the operator's
// Claude auth etc.), minus the in-session markers. CLADE_AGENT_MODEL is NOT
// injected here — it is a custom-adapter hint only (agent-core.mjs).
function claudeEnv() {
  const env = { ...process.env }
  delete env.CLADECODE
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE
  env.CLAUDE_HEADLESS = '1' // stand down the operator's harness hooks (auto-kickoff etc.)
  return env
}

// A custom adapter gets a MINIMAL environment, not the full parent env: it is
// arbitrary owner-configured (often third-party) code that talks to the internet,
// so it must not inherit every credential in the shell (angel-review — a buggy or
// tampered adapter could exfiltrate them). Only PATH/HOME plus the documented
// CLADE_AGENT_MODEL hint cross the boundary.
function customEnv(model) {
  const env = { CLAUDE_HEADLESS: '1', CLADE_AGENT_MODEL: model || '' }
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SystemRoot']) {
    if (process.env[k] != null) env[k] = process.env[k]
  }
  return env
}

// { prompt, model?, claudeModelDefault?, timeoutMs, maxBuffer } → { ok, text,
// limitHit, limitHitExplicit, stderr, err }. Model precedence: explicit opts.model
// (cue-tag's --model) → CLADE_AGENT_MODEL (custom mode only) → claudeModelDefault
// (a claude-mode-only fast default, e.g. cue-tag's 'sonnet'). A caller's fast
// default therefore never leaks into a custom adapter's model hint.
export async function runAgent({ prompt, model, claudeModelDefault, timeoutMs, maxBuffer }) {
  const cfg = resolveAgentConfig(process.env)
  const chosenModel = model ?? cfg.model ?? (cfg.mode === 'claude' ? claudeModelDefault : undefined)

  if (cfg.mode === 'claude') {
    // Research-only: allow exactly the web tools (explicit allowlist, not
    // bypassPermissions — root-privileged sandboxes reject bypass, and
    // least-privilege is right regardless).
    const args = ['-p', prompt, '--output-format', 'text', '--allowedTools', 'WebSearch,WebFetch']
    if (chosenModel) args.push('--model', chosenModel)
    const { err, stdout, stderr } = await new Promise((resolve) =>
      execFile(cfg.cmd, args, { env: claudeEnv(), maxBuffer, timeout: timeoutMs }, (e, out, se) =>
        resolve({ err: e, stdout: out || '', stderr: se || '' }),
      ),
    )
    const code = Number.isInteger(err?.code) ? err.code : err ? null : 0
    const outcome = classifyOutcome({ code, signal: err?.signal ?? null, stdout, stderr }, 'claude')
    return { ...outcome, stderr: redactSecrets(stderr), err }
  }

  if (cfg.argsMalformed) {
    console.warn('[agent] CLADE_AGENT_ARGS looks like a JSON array but did not parse — ignoring it')
  }
  return spawnStdin(cfg.cmd, cfg.args, {
    env: customEnv(chosenModel),
    timeoutMs,
    maxBuffer,
    input: prompt,
  })
}

function spawnStdin(cmd, args, { env, timeoutMs, maxBuffer, input }) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let child
    try {
      child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ ok: false, limitHit: false, limitHitExplicit: false, text: '', stderr: String(err.message), err })
      return
    }
    // Decode as UTF-8 so a multibyte codepoint split across pipe chunks is not
    // corrupted into replacement characters (angel-review — corrupted names/bios
    // were being banked permanently). setEncoding also makes the length caps below
    // count code units, matching the string accumulators.
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    const finish = (code, signal, err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const outcome = classifyOutcome({ code, signal, stdout, stderr }, 'custom')
      resolve({ ...outcome, stderr: redactSecrets(stderr), err })
    }
    const overflow = (streamName) => {
      child.kill('SIGKILL')
      finish(null, 'SIGKILL', new Error(`agent ${streamName} exceeded ${maxBuffer} bytes`))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null, 'SIGKILL', new Error(`agent timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (d) => {
      stdout += d
      if (stdout.length > maxBuffer) overflow('stdout')
    })
    // stderr is capped symmetrically with stdout — the built-in execFile path
    // bounds both, and a verbose/hostile custom adapter must not balloon memory
    // for the whole timeout window (angel-review).
    child.stderr.on('data', (d) => {
      stderr += d
      if (stderr.length > maxBuffer) overflow('stderr')
    })
    child.on('error', (err) => finish(null, null, err)) // e.g. ENOENT: adapter not found
    child.on('close', (code, signal) =>
      finish(code, signal, code === 0 || signal ? null : new Error(`agent exited ${code}`)),
    )

    child.stdin.on('error', () => { /* EPIPE if the adapter exits before reading — close handler reports it */ })
    child.stdin.end(input)
  })
}
