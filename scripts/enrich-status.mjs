#!/usr/bin/env node
// pattern: Functional Core (humanAge/summarize/countNonAnswers) + a thin
// imperative boundary (main)
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

import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { paths, scanBanks } from './enrich-batch.mjs'
import { CONFIRM_GROUP_SIZE, filterByUnitKind, isNonAnswer, planWork, selectCandidatesFrom } from './lib/enrich-core.mjs'

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

// Placeholder-valued fields in the BUILT index. Enrichment output can no longer
// produce these (validateEnrichment drops them), so a nonzero count is
// source-derived — a converter faithfully carrying an export that literally says
// "none". ADR-09 says leave those alone; this counts them so that call is under
// observation rather than assumed (revisit threshold: ~1% of the index).
export function countNonAnswers(index) {
  let n = 0
  for (const c of index) {
    for (const f of ['name', 'profession', 'employer']) if (isNonAnswer(c[f])) n++
  }
  return n
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
  const { index: indexPath, stopFile } = paths()

  if (!existsSync(indexPath)) {
    const msg = `No ${indexPath} — run: node scripts/build-index.mjs`
    if (json) console.log(JSON.stringify({ error: msg }, null, 2))
    else console.error(msg)
    process.exit(1)
  }

  const index = JSON.parse(readFileSync(indexPath, 'utf8'))
  const total = index.length
  const nonAnswers = countNonAnswers(index)
  const { attempted, lastBankedAt: last } = scanBanks()
  const s = summarize(selectCandidatesFrom(index, attempted))
  const lastAgeSec = last ? (Date.now() - Date.parse(last)) / 1000 : null
  const stopped = existsSync(stopFile)
  // Report only WHETHER a guard is set. The raw command is plausibly
  // credential-bearing (an inline `curl -H "Authorization: Bearer ..."` is the
  // obvious first implementation), and CLAUDE.md has the operating session run
  // this every session — so printing it would echo a secret into transcripts
  // that leave the machine (review, 2-way).
  const guardConfigured = Boolean(process.env.CLADE_ENRICH_GUARD)

  if (json) {
    console.log(
      JSON.stringify(
        { total, attempted: attempted.size, ...s, nonAnswerFields: nonAnswers, lastBankedAt: last, lastBankedAgeSec: lastAgeSec, stopFilePresent: stopped, guardConfigured },
        null,
        2,
      ),
    )
    return
  }

  const n = (x) => x.toLocaleString()
  console.log('\nClade enrichment status\n')
  console.log(`  index        ${n(total)} contacts`)
  console.log(`  attempted    ${n(attempted.size)} source keys`)
  console.log(`  backlog      ${n(s.backlog)} with seed signal, not yet attempted`)
  if (s.backlog) {
    console.log(`                 ${n(s.solo)} solo (1 session each)`)
    console.log(`                 ${n(s.confirm)} confirm (${CONFIRM_GROUP_SIZE} share a session)`)
    console.log(`  work units   ${n(s.units)} remaining`)
  }
  console.log(`  last banked  ${last ? `${last} (${humanAge(lastAgeSec)})` : 'never'}`)
  // Only surface when it's drifting toward the ADR-09 revisit threshold.
  if (nonAnswers > Math.max(5, total * 0.01))
    console.log(`  placeholders ${nonAnswers} source-derived non-answer fields (${((nonAnswers / total) * 100).toFixed(1)}%) — see ADR-09`)
  if (stopped) console.log(`  stop file    ${stopFile} PRESENT — runs will halt between batches`)
  console.log(`  guard        ${guardConfigured ? 'configured (CLADE_ENRICH_GUARD)' : 'none set — runs are ungated'}`)

  if (!s.backlog) {
    console.log('\nNothing queued. Ingest more sources, or triage thin contacts (CLAUDE.md step 4).\n')
    return
  }
  // No quota advice on purpose — see the header. Report the work; the owner decides.
  console.log(`\nNext: node scripts/enrich-batch.mjs --limit 25${stopped ? `   (clear ${stopFile} first)` : ''}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
