// pattern: imperative-shell
// Build the unified contact index from normalized sources + overlays.
//
//   node scripts/build-index.mjs
//
// Reads:  contacts/normalized/*.json   (per-source records — see docs/schema.md)
//         contacts/attested.json       (user-attested facts, keyed by record key)
//         contacts/enrichments/*.json  (web-research results, keyed by record key)
//         contacts/merge-decisions.json (human rulings: same/different)
// Writes: contacts/unified-index.json  (the search target — regenerated, never hand-edit)
//         contacts/merge-candidates.json (ambiguous cross-source pairs needing a ruling)
//
// All resolution/folding logic lives in scripts/lib/resolve.mjs (pure,
// unit-tested); this file only does file IO and reporting.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { validateEnrichment } from './lib/enrich-core.mjs'
import { unwrapDecisions, unwrapEntries } from './lib/envelope.mjs'
import { buildIndex } from './lib/resolve.mjs'

// LOAD-BEARING: these paths are cwd-relative on purpose. A private data instance
// (e.g. Krolodex) runs this engine against ITS OWN data via `cd <instance> &&
// node <clade>/scripts/build-index.mjs` — the paths resolve against the instance's
// cwd, so the owner's real contacts never enter this public repo's tree. Do NOT
// "fix" these to be relative to the script (import.meta.url): that would redirect
// every instance build into THIS repo's contacts/ dir — a private-data-into-public
// leak. See docs / CLAUDE.md conventions.
const NORM_DIR = 'contacts/normalized'
const ENRICH_DIR = 'contacts/enrichments'
const ATTESTED_PATH = 'contacts/attested.json'
const DECISIONS_PATH = 'contacts/merge-decisions.json'
const OUT_PATH = 'contacts/unified-index.json'
const CANDIDATES_PATH = 'contacts/merge-candidates.json'

// Fail loud with the offending filename — a malformed source or decisions file
// must never produce a silently smaller index.
function readJson(p, fallback) {
  if (!existsSync(p)) return fallback
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    console.error(`Malformed JSON in ${p}: ${e.message}`)
    process.exit(1)
  }
}

// Run an overlay-unwrap, turning a thrown "malformed envelope" into a clean
// exit-with-filename instead of a raw stack trace.
function failLoud(path, fn) {
  try {
    return fn()
  } catch (e) {
    console.error(`Malformed overlay in ${path}: ${e.message}`)
    process.exit(1)
  }
}

function main() {
  const sources = []
  const sourceFiles = existsSync(NORM_DIR)
    ? readdirSync(NORM_DIR).filter((f) => f.endsWith('.json')).sort()
    : []
  for (const f of sourceFiles) sources.push({ ...readJson(`${NORM_DIR}/${f}`, {}), file: f })

  // Enrichment batches are append-only and individually skippable; a corrupt
  // one warns rather than blocking the build. Values are re-validated on load
  // so a poisoned or hand-mangled batch can't inject junk into the index.
  const enrichments = {}
  if (existsSync(ENRICH_DIR)) {
    for (const f of readdirSync(ENRICH_DIR).filter((x) => x.endsWith('.json')).sort()) {
      let entries
      try {
        entries = unwrapEntries(JSON.parse(readFileSync(`${ENRICH_DIR}/${f}`, 'utf8')))
      } catch (e) {
        // Enrichment batches are individually skippable — a bad envelope warns
        // rather than blocking the whole build.
        console.warn(`skipping enrichment file ${f}: ${e.message}`)
        continue
      }
      for (const [k, v] of Object.entries(entries)) {
        const valid = validateEnrichment(v)
        if (valid) enrichments[k] = valid
        else console.warn(`skipping malformed enrichment for ${k} in ${f}`)
      }
    }
  }

  // attested.json and merge-decisions.json are singular, hand-written, and hold
  // the owner's irreplaceable facts — a malformed envelope must fail LOUD with the
  // filename (matching readJson), never silently collapse to empty (angel-review).
  const attested = failLoud(ATTESTED_PATH, () => unwrapEntries(readJson(ATTESTED_PATH, {})))
  const decisions = failLoud(DECISIONS_PATH, () => unwrapDecisions(readJson(DECISIONS_PATH, [])))

  const out = buildIndex({ sources, decisions, enrichments, attested })
  for (const w of out.warnings) console.warn(w)

  if (out.recordCount === 0) {
    console.log(`No normalized sources found in ${NORM_DIR}/ — nothing to build (existing outputs left untouched).`)
    return
  }

  writeFileSync(OUT_PATH, JSON.stringify(out.unified, null, 2))
  writeFileSync(CANDIDATES_PATH, JSON.stringify(out.candidates, null, 2))

  const tiers = {}
  const confidences = {}
  for (const u of out.unified) {
    tiers[u.tier] = (tiers[u.tier] || 0) + 1
    confidences[u.confidence] = (confidences[u.confidence] || 0) + 1
  }
  console.log(`Unified index: ${out.unified.length} people from ${out.recordCount} records across ${sourceFiles.length} source file(s)`)
  console.log('Tiers:', tiers)
  console.log('Confidence:', confidences)
  if (out.candidates.length > 0) {
    const exact = out.candidates.filter((c) => c.reason === 'exact-name').length
    console.log(`\n${out.candidates.length} ambiguous merge candidate(s) → ${CANDIDATES_PATH}${exact ? ` (${exact} exact-name — usually bulk-rulable)` : ''}`)
    console.log('Review them (see CLAUDE.md "Merge review") and record rulings in contacts/merge-decisions.json.')
  }
  console.log(`\nWrote ${OUT_PATH}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
