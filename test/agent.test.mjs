// pattern: imperative-shell
// Exercises the real spawn/stdin path of runAgent against fixture adapters — no
// Claude, no network. Proves a custom provider drops in via CLADE_AGENT_CMD.

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'
import { runAgent } from '../scripts/lib/agent.mjs'

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

afterEach(() => {
  delete process.env.CLADE_AGENT_CMD
  delete process.env.CLADE_AGENT_ARGS
  delete process.env.CLADE_AGENT_MODEL
  delete process.env.CLADE_TEST_SECRET
})

test('custom adapter: prompt goes in on stdin, response text comes back', async () => {
  process.env.CLADE_AGENT_CMD = 'node'
  process.env.CLADE_AGENT_ARGS = JSON.stringify([fixture('echo-json-adapter.mjs')])
  const r = await runAgent({ prompt: 'research Jane Wilson', timeoutMs: 10_000, maxBuffer: 1 << 20 })
  assert.equal(r.ok, true)
  assert.equal(r.limitHit, false)
  const parsed = JSON.parse(r.text.match(/```json\s*([\s\S]*?)```/)[1])
  assert.equal(parsed.marker, 'from-adapter')
  assert.equal(parsed.promptLen, 'research Jane Wilson'.length) // stdin delivered intact
})

test('custom adapter: exit 75 is surfaced as a rate-limit hit', async () => {
  process.env.CLADE_AGENT_CMD = 'node'
  process.env.CLADE_AGENT_ARGS = JSON.stringify([fixture('limit-adapter.mjs')])
  const r = await runAgent({ prompt: 'x', timeoutMs: 10_000, maxBuffer: 1 << 20 })
  assert.equal(r.ok, false)
  assert.equal(r.limitHit, true)
})

test('custom adapter: a plain non-zero exit is a failure, not a limit hit', async () => {
  process.env.CLADE_AGENT_CMD = 'node'
  process.env.CLADE_AGENT_ARGS = JSON.stringify([fixture('fail-adapter.mjs')])
  const r = await runAgent({ prompt: 'x', timeoutMs: 10_000, maxBuffer: 1 << 20 })
  assert.equal(r.ok, false)
  assert.equal(r.limitHit, false)
  assert.match(r.stderr, /boom/)
})

test('custom adapter: a missing executable resolves to a failure, never throws', async () => {
  process.env.CLADE_AGENT_CMD = '/no/such/adapter-binary'
  const r = await runAgent({ prompt: 'x', timeoutMs: 10_000, maxBuffer: 1 << 20 })
  assert.equal(r.ok, false)
  assert.equal(r.limitHit, false)
})

test('custom adapter: maxBuffer caps STDERR too, not just stdout', async () => {
  process.env.CLADE_AGENT_CMD = 'node'
  process.env.CLADE_AGENT_ARGS = JSON.stringify([fixture('stderr-flood-adapter.mjs')])
  const r = await runAgent({ prompt: 'x', timeoutMs: 20_000, maxBuffer: 64 * 1024 })
  // killed by the buffer cap, well before the 20s timeout, and stderr stays bounded
  assert.equal(r.ok, false)
  assert.ok(r.stderr.length <= 64 * 1024 + 4096, `stderr grew unbounded: ${r.stderr.length}`)
})

test('custom adapter: explicit model wins, CLADE_AGENT_MODEL feeds the adapter, and the env is minimal', async () => {
  process.env.CLADE_AGENT_CMD = 'node'
  process.env.CLADE_AGENT_ARGS = JSON.stringify([fixture('env-echo-adapter.mjs')])
  process.env.CLADE_AGENT_MODEL = 'gpt-4o'
  process.env.CLADE_TEST_SECRET = 'do-not-leak' // must NOT reach the minimal-env child

  // No explicit model → CLADE_AGENT_MODEL reaches the adapter; secret is filtered out.
  let r = await runAgent({ prompt: 'p', timeoutMs: 10_000, maxBuffer: 1 << 20 })
  let out = JSON.parse(r.text.match(/```json\s*([\s\S]*?)```/)[1])
  assert.equal(out.gotModel, 'gpt-4o')
  assert.equal(out.sawSecret, null, 'unrelated shell secret leaked into the adapter env')

  // Explicit model overrides CLADE_AGENT_MODEL; claudeModelDefault is ignored in custom mode.
  r = await runAgent({ prompt: 'p', model: 'llama-3', claudeModelDefault: 'sonnet', timeoutMs: 10_000, maxBuffer: 1 << 20 })
  out = JSON.parse(r.text.match(/```json\s*([\s\S]*?)```/)[1])
  assert.equal(out.gotModel, 'llama-3')
})
