// pattern: imperative-shell
// Resumable contact enrichment via a web-research agent (Claude by default; any
// web-capable agent via CLADE_AGENT_CMD — see docs/byo-model.md and lib/agent.mjs).
//
// Selects unified-index entries that lack a high/medium identification but have
// enough seed signal to research (employer, title, URLs, bio, or user-attested
// context), researches each in a parallel-limited batch of headless agent
// sessions, banks results to contacts/enrichments/batch-<ts>-<pid>.json, and
// rebuilds the index after each batch. Every banked key is permanently
// "attempted" — the next run picks up where this one stopped, so running this
// in short sessions over days is the normal mode, not a failure mode.
//
// Run:    node scripts/enrich-batch.mjs --limit 30
// Stop:   touch .stop-enrichment        (checked between batches)
// Dry:    node scripts/enrich-batch.mjs --dry-run
//
// Flags:  --limit N        max contacts this run (default 25 — a comfortable
//                          single-session bite; raise once you know your quota)
//         --concurrency N  parallel agent calls (default 3)
//         --model M        model for the research sessions (claude mode defaults
//                          to a fast model — identification is retrieval work)
//         --dry-run        print the selection, no agent calls
//         --max-retries N  backoff retries when rate-limited (default 4)
//         --guard-cmd CMD  (or env CLADE_ENRICH_GUARD) a command run between
//                          batches; a non-zero exit stops the run cleanly, like
//                          the stop-file. This is the seam an instance uses to
//                          plug in a usage-meter / budget / time-window guard —
//                          the engine stays ignorant of the instance's specific
//                          quota, proxy endpoint, or soak policy (all of which
//                          live in CMD). The guard's stderr first line becomes
//                          the stop reason.
//
// Cost shape: contacts that already carry a LinkedIn URL are cheap 1-2-fetch
// confirms, so they share sessions in groups (enrich-core planWork) to amortize
// per-session overhead; open-ended research runs solo. The owner's life-history
// prior is injected only for solo (thin) contacts — era disambiguation is
// useless when a profile URL is already in hand.
//
// A lockfile (.enrich-lock) refuses concurrent runs — two runs would pay for
// the same candidates. Hitting the provider's usage limit mid-run is
// expected and harmless: the run backs off, retries, and if the limit persists
// it stops cleanly. Un-banked contacts stay un-attempted and are first in line
// next run.
//
// Prompt-injection posture (see scripts/lib/enrich-core.mjs): contact fields
// are untrusted, so they're fenced as data, URLs are filtered before the model
// may fetch them, and responses are schema-validated before being banked.

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  clean,
  foldUnit,
  isEnrichmentRecord,
  parseJsonBlock,
  planWork,
  promptForUnit,
  seedScore,
  selectCandidatesFrom,
} from './lib/enrich-core.mjs'
import { runAgent } from './lib/agent.mjs'
import { unwrapEntries, wrapEntries } from './lib/envelope.mjs'
import { dataPath } from './paths.mjs'

const INDEX_PATH = dataPath('contacts/unified-index.json')
const ENRICH_DIR = dataPath('contacts/enrichments')
const PRIOR_PATH = dataPath('profile/about-me.md')
// Control-plane, NOT data: stays cwd-relative so 'touch .stop-enrichment' works
// from wherever the operator is running, per CLAUDE.md.
const STOP_FILE = '.stop-enrichment'
const LOCK_PATH = dataPath('.enrich-lock')

const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : def
}
const LIMIT = Number(flag('--limit', '25'))
const CONCURRENCY = Number(flag('--concurrency', '3'))
const MODEL = flag('--model', null) // explicit user override only (no hardcoded default); when set it DOES outrank an ambient CLADE_AGENT_MODEL for this run
const DRY = argv.includes('--dry-run')
const MAX_RETRIES = Number(flag('--max-retries', '4'))
const GUARD_CMD = flag('--guard-cmd', process.env.CLADE_ENRICH_GUARD || null)
const BACKOFF_BASE_MS = 20_000
const BACKOFF_CAP_MS = 180_000

// Pluggable between-batch guard: an instance supplies a command (a usage-meter,
// budget, or time-window check) that can veto continuing. A non-zero exit stops
// the run cleanly, exactly like the stop-file — keeping the engine ignorant of
// the instance's specific quota/proxy/soak policy, which lives in the command.
// Returns a stop-reason string when the guard vetoes, else null.
function guardStop() {
  if (!GUARD_CMD) return null
  try {
    execSync(GUARD_CMD, { stdio: 'pipe' })
    return null
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message || '').split('\n')[0].trim()
    return `guard vetoed continuation${msg ? `: ${msg}` : ''} (--guard-cmd)`
  }
}

// --- single-run lock ----------------------------------------------------------

function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    const pid = Number(readFileSync(LOCK_PATH, 'utf8').trim())
    let alive = false
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0)
        alive = true
      } catch { /* stale */ }
    }
    if (alive) {
      console.error(`[enrich] another enrichment run is active (pid ${pid}) — refusing to double-spend. Remove ${LOCK_PATH} if that's wrong.`)
      process.exit(1)
    }
    console.warn(`[enrich] stale ${LOCK_PATH} (pid ${pid} gone) — taking over`)
  }
  writeFileSync(LOCK_PATH, String(process.pid))
  process.on('exit', () => {
    try { unlinkSync(LOCK_PATH) } catch { /* already gone */ }
  })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))
}

// --- candidate selection --------------------------------------------------------

// Only well-formed banked values count as attempted: a malformed value (e.g. a
// hand-edited batch file) must be retried, not permanently skipped.
function attemptedKeys() {
  const seen = new Set()
  if (!existsSync(ENRICH_DIR)) return seen
  for (const f of readdirSync(ENRICH_DIR).filter((x) => x.endsWith('.json'))) {
    try {
      for (const [k, v] of Object.entries(unwrapEntries(JSON.parse(readFileSync(`${ENRICH_DIR}/${f}`, 'utf8')))))
        if (isEnrichmentRecord(v)) seen.add(k)
    } catch { /* skip unreadable */ }
  }
  return seen
}

function selectCandidates() {
  if (!existsSync(INDEX_PATH)) {
    console.error(`No ${INDEX_PATH} — run: node scripts/build-index.mjs`)
    process.exit(1)
  }
  return selectCandidatesFrom(JSON.parse(readFileSync(INDEX_PATH, 'utf8')), attemptedKeys())
}

// --- agent plumbing --------------------------------------------------------------
// The web-research call goes through the pluggable agent provider (scripts/lib/
// agent.mjs): Claude by default, any web-capable agent via CLADE_AGENT_CMD
// (docs/byo-model.md). Prompt building, parsing, validation, and backoff are all
// model-agnostic and stay here.

const prior = existsSync(PRIOR_PATH) ? readFileSync(PRIOR_PATH, 'utf8').slice(0, 4000) : ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const backoffMs = (attempt) =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt) * (0.8 + Math.random() * 0.4)

// One work unit = one agent session: a solo open-research contact, or a
// confirm group sharing a session (see planWork). Routing, validation, and
// outcome-folding are pure (promptForUnit/foldUnit in enrich-core, where the
// exit-75/fuzzy-limit precedence rules live and are tested); this shell only
// spawns, stamps, and warns. Returns { limitHit: true } for a throttled unit,
// else { outcomes: [{ key, result } | { key, failed }] }.
async function enrichUnit(unit) {
  const contacts = unit.contacts
  const { prompt, grouped, timeoutMs } = promptForUnit(unit, prior)
  const { ok, text, limitHit, limitHitExplicit, stderr, err } = await runAgent({
    prompt,
    model: MODEL,
    claudeModelDefault: 'sonnet',
    timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  const folded = foldUnit(contacts, grouped, parseJsonBlock(text), { limitHit, limitHitExplicit })
  if (folded.limitHit) return folded
  const enrichedAt = new Date().toISOString()
  for (const o of folded.outcomes) if (o.result) o.result = { ...o.result, enrichedAt }
  // No parseable result — warn whether the process failed OR exited 0 with
  // unparseable output. The latter (a well-behaved-exit adapter that forgot the
  // ```json block) is an adapter author's likeliest first bug and was silent.
  if (folded.banked === 0) {
    console.warn(
      `[enrich] ${contacts.map((c) => clean(c.name, 60)).join(', ')}: no usable result — ${ok ? 'agent exited 0 but output had no JSON block' : `agent failed: ${clean(stderr || err?.message || '', 200)}`}`,
    )
  } else if (folded.banked < contacts.length) {
    // Partial group result: the missing entries stay un-banked and retry later.
    console.warn(`[enrich] confirm group returned ${folded.banked}/${contacts.length} entries — the rest will be retried`)
  }
  return folded
}

// Enrich one wave of units, retrying only rate-limited units with backoff.
// Successful results persist across retries. Returns { results, resolved, stop }.
async function runBatch(units) {
  const results = {}
  let resolved = 0
  let pending = units

  for (let attempt = 0; ; attempt++) {
    const unitOutcomes = await Promise.all(pending.map(enrichUnit))
    const throttled = []
    for (let k = 0; k < unitOutcomes.length; k++) {
      const u = unitOutcomes[k]
      if (u.limitHit) {
        throttled.push(pending[k])
        continue
      }
      for (const o of u.outcomes) {
        if (o.result) {
          results[o.key] = o.result
          if (['high', 'medium'].includes(o.result.confidence)) resolved++
        }
        // o.failed → drop; stays un-banked, first in line next run.
      }
    }
    if (throttled.length === 0) return { results, resolved, stop: false }
    if (attempt >= MAX_RETRIES) {
      return { results, resolved, stop: true, stopReason: `usage limit persisted through ${MAX_RETRIES} backoff retries — likely out of quota for this window; re-run later, it resumes automatically` }
    }
    const wait = backoffMs(attempt)
    console.log(`[enrich] rate-limited on ${throttled.length} session(s) — backing off ${(wait / 1000).toFixed(0)}s (retry ${attempt + 1}/${MAX_RETRIES})`)
    await sleep(wait)
    pending = throttled
  }
}

// --- main loop ---------------------------------------------------------------------

async function main() {
  let candidates = selectCandidates()
  console.log(`[enrich] ${candidates.length} candidates with seed signal, not yet attempted`)
  if (DRY) {
    for (const c of candidates.slice(0, Math.max(LIMIT, 20)))
      console.log(`  - ${clean(c.name, 60)} [${c.tier}] seed:${seedScore(c)} ${clean(c.employer || c.bio?.slice(0, 40) || c.urls?.[0] || '', 60)}`)
    console.log('[enrich] dry run — no claude calls made')
    return
  }
  acquireLock()
  candidates = candidates.slice(0, LIMIT)
  const units = planWork(candidates)

  let done = 0
  let resolved = 0
  let stoppedReason = 'batch complete'

  for (let i = 0; i < units.length; i += CONCURRENCY) {
    if (existsSync(STOP_FILE)) {
      stoppedReason = 'stop-file present (.stop-enrichment)'
      break
    }
    const guardReason = guardStop()
    if (guardReason) {
      stoppedReason = guardReason
      break
    }
    const wave = units.slice(i, i + CONCURRENCY)
    const r = await runBatch(wave)
    resolved += r.resolved
    done += wave.reduce((s, u) => s + u.contacts.length, 0)

    if (Object.keys(r.results).length > 0) {
      // pid suffix: concurrent/rapid runs must never overwrite each other's batch
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      mkdirSync(ENRICH_DIR, { recursive: true })
      writeFileSync(`${ENRICH_DIR}/batch-${ts}-${process.pid}.json`, JSON.stringify(wrapEntries(r.results), null, 2))
      try {
        execSync('node scripts/build-index.mjs', { stdio: 'pipe' })
      } catch (e) {
        console.warn(`[enrich] index rebuild failed: ${String(e.message).split('\n')[0]} — results are banked; run node scripts/build-index.mjs manually`)
      }
    }
    console.log(`[enrich] ${done}/${candidates.length} attempted | ${resolved} identified (high/medium)`)
    if (r.stop) {
      stoppedReason = r.stopReason
      break
    }
  }

  console.log(`[enrich] STOPPED: ${stoppedReason}. ${done} attempted, ${resolved} identified.`)
  console.log('[enrich] Re-running later resumes automatically — attempted contacts are never re-tried.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('[enrich] fatal:', e?.message ?? e)
    process.exit(1)
  })
}
