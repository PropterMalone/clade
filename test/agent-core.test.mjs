// pattern: functional-core
// Pure config + outcome classification for the agent provider seam (docs/byo-model.md).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyOutcome, redactSecrets, resolveAgentConfig } from '../scripts/lib/agent-core.mjs'

test('resolveAgentConfig defaults to claude mode when CLADE_AGENT_CMD is unset', () => {
  const cfg = resolveAgentConfig({})
  assert.equal(cfg.mode, 'claude')
})

test('resolveAgentConfig switches to custom mode when CLADE_AGENT_CMD is set', () => {
  const cfg = resolveAgentConfig({ CLADE_AGENT_CMD: './my-agent.sh' })
  assert.equal(cfg.mode, 'custom')
  assert.equal(cfg.cmd, './my-agent.sh')
  assert.deepEqual(cfg.args, [])
})

test('resolveAgentConfig parses CLADE_AGENT_ARGS as a JSON array (handles spaces in args)', () => {
  const cfg = resolveAgentConfig({
    CLADE_AGENT_CMD: 'python3',
    CLADE_AGENT_ARGS: '["adapter.py", "--search", "web mode"]',
  })
  assert.deepEqual(cfg.args, ['adapter.py', '--search', 'web mode'])
})

test('resolveAgentConfig falls back to whitespace-split for non-JSON CLADE_AGENT_ARGS', () => {
  const cfg = resolveAgentConfig({
    CLADE_AGENT_CMD: 'python3',
    CLADE_AGENT_ARGS: 'adapter.py --search',
  })
  assert.deepEqual(cfg.args, ['adapter.py', '--search'])
  assert.equal(cfg.argsMalformed, false)
})

test('resolveAgentConfig flags a JSON-array-looking CLADE_AGENT_ARGS that fails to parse', () => {
  // A "[" prefix signals JSON-array intent; a typo must not silently whitespace-split
  // the raw JSON into garbage tokens — it yields empty args + argsMalformed.
  const cfg = resolveAgentConfig({ CLADE_AGENT_CMD: 'x', CLADE_AGENT_ARGS: '["--flag", oops]' })
  assert.deepEqual(cfg.args, [])
  assert.equal(cfg.argsMalformed, true)
})

test('resolveAgentConfig carries CLADE_AGENT_MODEL ONLY in custom mode', () => {
  // Custom mode: the hint is for the adapter.
  assert.equal(resolveAgentConfig({ CLADE_AGENT_CMD: 'x', CLADE_AGENT_MODEL: 'gpt-4o' }).model, 'gpt-4o')
  // Claude mode: CLADE_AGENT_MODEL must NOT surface — the default claude call stays unchanged.
  assert.equal(resolveAgentConfig({ CLADE_AGENT_MODEL: 'gpt-4o' }).model, undefined)
  assert.equal(resolveAgentConfig({}).model, undefined)
})

test('classifyOutcome: clean exit is ok, carries stdout as text', () => {
  const o = classifyOutcome({ code: 0, signal: null, stdout: '```json\n{}\n```', stderr: '' }, 'custom')
  assert.equal(o.ok, true)
  assert.equal(o.limitHit, false)
  assert.equal(o.text, '```json\n{}\n```')
})

test('classifyOutcome: exit 75 is an EXPLICIT limit hit in any mode', () => {
  for (const mode of ['custom', 'claude']) {
    const o = classifyOutcome({ code: 75, signal: null, stdout: '', stderr: '' }, mode)
    assert.equal(o.limitHit, true)
    assert.equal(o.limitHitExplicit, true)
  }
})

test('classifyOutcome: a claude free-text limit is a heuristic hit, NOT explicit', () => {
  const o = classifyOutcome({ code: 1, signal: null, stdout: '', stderr: 'Error: 429' }, 'claude')
  assert.equal(o.limitHit, true)
  assert.equal(o.limitHitExplicit, false)
})

test('classifyOutcome: other non-zero exit is a plain failure, not a limit hit', () => {
  const o = classifyOutcome({ code: 1, signal: null, stdout: '', stderr: 'boom' }, 'custom')
  assert.equal(o.ok, false)
  assert.equal(o.limitHit, false)
})

test('classifyOutcome: claude mode reads LIMIT_HIT_RE from stderr on process error (back-compat)', () => {
  const o = classifyOutcome({ code: 1, signal: null, stdout: '', stderr: 'Error: 429 rate limit exceeded' }, 'claude')
  assert.equal(o.ok, false)
  assert.equal(o.limitHit, true)
})

test('classifyOutcome: custom mode does NOT infer a limit from free text — only exit 75', () => {
  // A custom adapter must signal throttling explicitly (exit 75); a bio echoing
  // "rate limit" in stdout must never be misread as a throttle.
  const o = classifyOutcome({ code: 1, signal: null, stdout: 'bio: works on rate limiting', stderr: '' }, 'custom')
  assert.equal(o.limitHit, false)
})

test('classifyOutcome: a successful response mentioning "rate limit" is not a throttle', () => {
  const o = classifyOutcome({ code: 0, signal: null, stdout: '{"notes":"expert in rate limiting"}', stderr: '' }, 'claude')
  assert.equal(o.ok, true)
  assert.equal(o.limitHit, false)
})

test('redactSecrets masks common credential shapes, leaves ordinary text alone', () => {
  assert.match(redactSecrets('Authorization: Bearer abc123XYZ'), /\[redacted\]/)
  assert.doesNotMatch(redactSecrets('Authorization: Bearer abc123XYZ'), /abc123XYZ/)
  assert.doesNotMatch(redactSecrets('key sk-ABCD1234efgh5678'), /sk-ABCD1234/)
  assert.doesNotMatch(redactSecrets('api_key=SUPERSECRETVALUE'), /SUPERSECRETVALUE/)
  assert.doesNotMatch(redactSecrets('AKIAIOSFODNN7EXAMPLE fell over'), /AKIAIOSFODNN7EXAMPLE/)
  assert.equal(redactSecrets('ordinary error: contact not found'), 'ordinary error: contact not found')
})
