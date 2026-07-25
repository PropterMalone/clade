#!/usr/bin/env node
// pattern: imperative-shell
// What enrichment would do next, without doing it. Answers "is there a backlog,
// how big is the job, and when did I last run?" so a session can offer a batch
// instead of the owner remembering to ask.
//
// Run:  node scripts/enrich-status.mjs [--json]
//
// Deliberately knows NOTHING about provider quota. Clade cannot read your
// subscription's remaining budget without depending on a provider-specific
// meter, and it stays zero-dependency (see ADR-07). The owner is the quota
// oracle — they can see their own usage — so this reports the WORK and leaves
// the GO/NO-GO to them. For unattended drip, wire a quota-aware guard to
// --guard-cmd / CLADE_ENRICH_GUARD; see docs/byo-model.md.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { attemptedKeys, paths, selectCandidates } from './enrich-batch.mjs'
import { CONFIRM_GROUP_SIZE, filterByUnitKind, planWork } from './lib/enrich-core.mjs'
import { unwrapEntries } from './lib/envelope.mjs'

const AGES = [
  [86400 * 365, 'y'],
  [86400 * 30, 'mo'],
  [86400, 'd'],
  [3600, 'h'],
  [60, 'm'],
]

export function humanAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown'
  for (const [span, unit] of AGES) {
    if (seconds >= span) return `${Math.floor(seconds / span)}${unit} ago`
  }
  return 'just now'
}

// Most recent enrichedAt across every bank — "when did enrichment last produce
// anything", which is the question a session-start offer needs.
export function lastBankedAt(enrichDir, { exists = existsSync, readDir = readdirSync, readFile = readFileSync } = {}) {
  if (!exists(enrichDir)) return null
  let latest = null
  for (const f of readDir(enrichDir).filter((x) => x.endsWith('.json'))) {
    try {
      for (const v of Object.values(unwrapEntries(JSON.parse(readFile(`${enrichDir}/${f}`, 'utf8'))))) {
        const t = v?.enrichedAt
        if (typeof t === 'string' && (!latest || t > latest)) latest = t
      }
    } catch {
      /* an unreadable bank is enrich-batch's problem, not status's */
    }
  }
  return latest
}

// Work units, not contacts: confirm-tier contacts share a session in groups, so
// a LinkedIn-heavy backlog is cheaper per head than a thin one. Same split
// planWork uses, so the estimate matches what a run would actually spend.
export function summarize(candidates) {
  const solo = filterByUnitKind(candidates, 'solo').length
  const confirm = filterByUnitKind(candidates, 'confirm').length
  return {
    backlog: candidates.length,
    solo,
    confirm,
    units: planWork(candidates).length,
    confirmGroupSize: CONFIRM_GROUP_SIZE,
  }
}

function main() {
  const json = process.argv.includes('--json')
  const { index: indexPath, enrichDir, stopFile } = paths()

  if (!existsSync(indexPath)) {
    const msg = `No ${indexPath} — run: node scripts/build-index.mjs`
    if (json) console.log(JSON.stringify({ error: msg }, null, 2))
    else console.error(msg)
    process.exit(1)
  }

  const total = JSON.parse(readFileSync(indexPath, 'utf8')).length
  const attempted = attemptedKeys().size
  const s = summarize(selectCandidates())
  const last = lastBankedAt(enrichDir)
  const lastAgeSec = last ? (Date.now() - Date.parse(last)) / 1000 : null
  const stopped = existsSync(stopFile)
  const guard = process.env.CLADE_ENRICH_GUARD || null

  if (json) {
    console.log(
      JSON.stringify(
        { total, attempted, ...s, lastBankedAt: last, lastBankedAgeSec: lastAgeSec, stopFilePresent: stopped, guard },
        null,
        2,
      ),
    )
    return
  }

  const n = (x) => x.toLocaleString()
  console.log('\nClade enrichment status\n')
  console.log(`  index        ${n(total)} contacts`)
  console.log(`  attempted    ${n(attempted)}`)
  console.log(`  backlog      ${n(s.backlog)} with seed signal, not yet attempted`)
  if (s.backlog) {
    console.log(`                 ${n(s.solo)} solo (1 session each)`)
    console.log(`                 ${n(s.confirm)} confirm (${CONFIRM_GROUP_SIZE} share a session)`)
    console.log(`  work units   ${n(s.units)} remaining`)
  }
  console.log(`  last banked  ${last ? `${last} (${humanAge(lastAgeSec)})` : 'never'}`)
  if (stopped) console.log(`  stop file    ${stopFile} PRESENT — runs will halt between batches`)
  console.log(`  guard        ${guard ? guard : 'none set — runs are ungated (CLADE_ENRICH_GUARD)'}`)

  if (!s.backlog) {
    console.log('\nNothing queued. Ingest more sources, or triage thin contacts (CLAUDE.md step 4).\n')
    return
  }
  // No quota advice on purpose — see the header. Report the work; the owner decides.
  console.log(`\nNext: node scripts/enrich-batch.mjs --limit 25${stopped ? `   (clear ${stopFile} first)` : ''}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
