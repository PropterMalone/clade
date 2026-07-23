// pattern: imperative-shell
// Cue-anchored pre-tagging: web-check a batch of thin contacts against one
// owner-supplied life-context cue, and propose tags for owner confirmation.
//
// Propose: node scripts/cue-tag.mjs --cue "grew up in Chadron, NE (high school 1990s)" \
//            --tag "hometown friend — Chadron, NE" [--source facebook] [--year 2010] [--limit 40]
// Review:  contacts/cue-proposals.json (grouped yes/unsure/no + evidence)
// Apply:   node scripts/cue-tag.mjs --apply yes            (all "yes" proposals)
//          node scripts/cue-tag.mjs --apply facebook:ryan-itani,facebook:alex-fox
//
// Applying writes contacts/attested.json entries (relationship = the --tag,
// context = cue + evidence + owner-confirmed marker). Nothing becomes attested
// without an explicit --apply — proposals are machine guesses, attestation is
// the owner's.
//
// WORKS BEST ON SHALLOW POOLS: a small hometown or a small college is nearly a
// unique key per name; "Los Angeles" is not. Big-city/big-org cues will come
// back mostly "unsure" — that's the tool being honest, not broken.
//
// Selection: entries lacking attested facts and high/medium enrichment, with
// a human-shaped name. Spends real provider quota (one websearch call per name;
// Claude by default, any web-capable agent via CLADE_AGENT_CMD — docs/byo-model.md).

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runAgent } from './lib/agent.mjs'
import { buildCueBatchPrompt, clean, isKeyShapedName, parseJsonBlock, validateCueBatchVerdicts } from './lib/enrich-core.mjs'
import { unwrapEntries, wrapEntries } from './lib/envelope.mjs'

const INDEX_PATH = 'contacts/unified-index.json'
const ATTESTED_PATH = 'contacts/attested.json'
// Each cue banks to its own file (--proposals) so two cue runs can go in
// parallel; the default keeps single-cue usage simple.
const PROPOSALS_PATH = (() => {
  const i = process.argv.indexOf('--proposals')
  return i >= 0 ? process.argv[i + 1] : 'contacts/cue-proposals.json'
})()

const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : def
}

// One session verdicts a whole batch: the cue's web context is researched
// once per call, not once per name. Cue checks are light lookups, so they run
// on a fast model by default (--model to override). Runs through the pluggable
// agent provider (Claude by default; CLADE_AGENT_CMD to swap — docs/byo-model.md).
async function checkBatch(batch, cue, model) {
  const { ok, text, stderr, err } = await runAgent({
    prompt: buildCueBatchPrompt(batch, cue),
    model, // explicit --model only (null otherwise) — never clobbers CLADE_AGENT_MODEL
    claudeModelDefault: 'sonnet', // fast default for cue checks, claude-mode only
    timeoutMs: 6 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  })
  const stderrSnippet = (stderr || '').trim().split('\n').at(-1)
  const verdicts = validateCueBatchVerdicts(parseJsonBlock(text), batch.length)
  return batch.map((c, i) => ({
    key: c.keys[0],
    name: c.name,
    ...verdicts[i],
    ...(!ok && !verdicts[i].evidence ? { evidence: `check failed: ${clean(stderrSnippet || err?.message || '', 160)}` } : {}),
  }))
}

const isFailed = (x) => String(x.evidence || '').startsWith('check failed')

async function propose() {
  const retryFailed = argv.includes('--retry-failed')
  let carried = []
  let prev = null
  if (retryFailed) {
    if (!existsSync(PROPOSALS_PATH)) {
      console.error(`--retry-failed needs an existing ${PROPOSALS_PATH}`)
      process.exit(1)
    }
    prev = JSON.parse(readFileSync(PROPOSALS_PATH, 'utf8'))
    carried = prev.proposals.filter((x) => !isFailed(x))
  }
  const cue = flag('--cue', prev?.cue)
  const tag = flag('--tag', prev?.tag)
  if (!cue || !tag) {
    console.error('usage: node scripts/cue-tag.mjs --cue "<life context>" --tag "<relationship label>" [--source S] [--year YYYY] [--limit N] [--concurrency N] [--proposals FILE]')
    process.exit(1)
  }
  const source = flag('--source', null)
  const year = flag('--year', null)
  const limit = Number(flag('--limit', '400'))
  const concurrency = Number(flag('--concurrency', '3'))
  const batchSize = Number(flag('--batch-size', '8'))
  const model = flag('--model', null) // explicit override only; the claude-mode fast default lives in checkBatch

  if (existsSync(PROPOSALS_PATH) && !retryFailed && !argv.includes('--force')) {
    console.error(`${PROPOSALS_PATH} exists with unapplied proposals — apply or delete it first (or pass --force to overwrite).`)
    process.exit(1)
  }
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'))
  const failedKeys = prev ? new Set(prev.proposals.filter(isFailed).map((x) => x.key)) : null
  const pool = index.filter(
    (c) =>
      !c.attested &&
      !['high', 'medium'].includes(c.enrichment?.confidence) &&
      !c.employer && !c.profession && !c.linkedinUrl && // thin contacts only: identifiable people don't need a cue check
      c.name && !isKeyShapedName(c.name) &&
      (!source || (c.sources || []).includes(source)) &&
      (!year || Object.values(c.connectedOn || {}).some((d) => String(d).startsWith(year))) &&
      (!failedKeys || failedKeys.has(c.keys[0])),
  ).slice(0, limit)

  const batches = []
  for (let i = 0; i < pool.length; i += batchSize) batches.push(pool.slice(i, i + batchSize))
  console.log(`[cue-tag] checking ${pool.length} contacts against cue (${batches.length} batches of ≤${batchSize}, model ${model}): ${cue}`)
  const results = [...carried]
  const bank = (complete) =>
    writeFileSync(PROPOSALS_PATH, JSON.stringify({ cue, tag, proposedAt: new Date().toISOString(), complete, proposals: results }, null, 2))
  for (let i = 0; i < batches.length; i += concurrency) {
    const wave = batches.slice(i, i + concurrency)
    for (const r of await Promise.all(wave.map((b) => checkBatch(b, cue, model)))) results.push(...r)
    bank(false) // crash-safe: partial proposals are still reviewable
    console.log(`[cue-tag] ${results.length - carried.length}/${pool.length}`)
  }
  bank(true)
  for (const verdict of ['yes', 'unsure', 'no']) {
    const hits = results.filter((r) => r.verdict === verdict)
    if (hits.length === 0) continue
    console.log(`\n${verdict.toUpperCase()} (${hits.length}):`)
    for (const h of hits) console.log(`  ${h.name}${h.evidence ? ` — ${h.evidence}` : ''}`)
  }
  console.log(`\nWrote ${PROPOSALS_PATH}. Apply: node scripts/cue-tag.mjs --apply yes  (or a comma-list of keys)`)
}

function apply() {
  const what = flag('--apply')
  if (!existsSync(PROPOSALS_PATH)) {
    console.error(`No ${PROPOSALS_PATH} — run a --cue pass first.`)
    process.exit(1)
  }
  const { cue, tag, proposals } = JSON.parse(readFileSync(PROPOSALS_PATH, 'utf8'))
  const wanted =
    what === 'yes'
      ? proposals.filter((p) => p.verdict === 'yes')
      : proposals.filter((p) => what.split(',').map((s) => s.trim()).includes(p.key))
  if (wanted.length === 0) {
    console.error('Nothing matched — check the key list or verdicts.')
    process.exit(1)
  }
  let attested = {}
  if (existsSync(ATTESTED_PATH)) {
    try {
      attested = unwrapEntries(JSON.parse(readFileSync(ATTESTED_PATH, 'utf8')))
    } catch (e) {
      console.error(`Malformed ${ATTESTED_PATH}: ${e.message} — fix it before applying.`)
      process.exit(1)
    }
  }
  for (const p of wanted) {
    // Merge over any existing attested fields — never clobber owner-authored
    // facts — and mark provenance: this context came through a web check, not
    // the owner's own words (angel-review 2026-07-19).
    attested[p.key] = {
      ...attested[p.key],
      relationship: tag,
      context: `${cue}. Cue-checked${p.evidence ? ` (${p.evidence})` : ''}, owner-confirmed ${new Date().toISOString().slice(0, 10)}.`,
      corroboration: 'web',
    }
  }
  writeFileSync(ATTESTED_PATH, JSON.stringify(wrapEntries(attested), null, 2))
  unlinkSync(PROPOSALS_PATH)
  console.log(`Attested ${wanted.length} contact(s) as "${tag}". Rebuild: node scripts/build-index.mjs`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (argv.includes('--apply')) apply()
  else propose().catch((e) => { console.error('[cue-tag] fatal:', e?.message ?? e); process.exit(1) })
}
