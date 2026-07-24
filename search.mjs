// pattern: imperative-shell
// CLI search over the clade unified contact index.
// Usage:
//   node search.mjs <query>            — full-text search across all fields
//   node search.mjs --domain <tag>     — filter by domain/expertise
//   node search.mjs --role <role>      — filter by role/title
//   node search.mjs --confidence high  — filter by confidence (high|medium|low|attested|none)
//   node search.mjs --source <src>     — filter by source (linkedin, facebook, ... or "multi")
//   node search.mjs --tier <tier>      — filter by tier (multi-source, facebook-only, ...)
//   node search.mjs --stats            — index statistics
//   node search.mjs --limit N          — max results (default 50)
//
// Flags combine. Query words are AND-ed substring matches.

import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { clean } from './scripts/lib/enrich-core.mjs'
import { dataPath } from './scripts/paths.mjs'

const indexPath = dataPath('contacts/unified-index.json')

export function matchesQuery(c, q) {
  if (!q) return true
  const haystack = [
    c.name, c.profession, c.employer, c.bio, c.notes,
    c.attested?.relationship, c.attested?.context,
    ...Object.values(c.handles || {}),
    ...(c.domains || []), ...(c.roles || []),
    ...(c.emails || []), ...(c.labels || []),
  ].filter(Boolean).join(' ').toLowerCase()
  return q.split(/\s+/).every((word) => haystack.includes(word))
}

// Contact fields are third-party text; strip control chars so a crafted bio
// can't drive terminal escape sequences when the owner searches (angel-review).
const show = (s) => clean(s, 500)

function main() {
  if (!existsSync(indexPath)) {
    console.log('No index yet — run: node scripts/build-index.mjs')
    process.exit(1)
  }
  const index = JSON.parse(readFileSync(indexPath, 'utf8'))
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.log('usage: node search.mjs [--domain TAG] [--role ROLE] [--confidence LEVEL] [--source SRC] [--tier TIER] [--stats] [--limit N] [QUERY...]')
    console.log(`index: ${index.length} contacts (${indexPath})`)
    process.exit(0)
  }

  let domainFilter = null
  let roleFilter = null
  let confFilter = null
  let sourceFilter = null
  let tierFilter = null
  let showStats = false
  let limit = 50
  const queryParts = []

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--domain' && args[i + 1]) domainFilter = args[++i].toLowerCase()
    else if (args[i] === '--role' && args[i + 1]) roleFilter = args[++i].toLowerCase()
    else if (args[i] === '--confidence' && args[i + 1]) confFilter = args[++i].toLowerCase()
    else if (args[i] === '--source' && args[i + 1]) sourceFilter = args[++i].toLowerCase()
    else if (args[i] === '--tier' && args[i + 1]) tierFilter = args[++i].toLowerCase()
    else if (args[i] === '--limit' && args[i + 1]) {
      const n = Number.parseInt(args[++i], 10)
      if (Number.isFinite(n) && n > 0) limit = n
      else console.warn(`ignoring non-numeric --limit "${args[i]}" (using ${limit})`)
    } else if (args[i] === '--stats') showStats = true
    else queryParts.push(args[i])
  }

  if (showStats) {
    const tiers = {}
    const sources = {}
    const domains = {}
    const confidences = {}
    for (const c of index) {
      tiers[c.tier] = (tiers[c.tier] || 0) + 1
      for (const s of c.sources || []) sources[s] = (sources[s] || 0) + 1
      for (const d of c.domains || []) domains[d] = (domains[d] || 0) + 1
      confidences[c.confidence || 'none'] = (confidences[c.confidence || 'none'] || 0) + 1
    }
    console.log(`=== ${index.length} contacts ===`)
    console.log('\nTiers:', tiers)
    console.log('Sources:', sources)
    console.log('Confidence:', confidences)
    console.log('\n=== Top 30 domains ===')
    Object.entries(domains).sort((a, b) => b[1] - a[1]).slice(0, 30)
      .forEach(([d, c]) => console.log(`  ${String(c).padStart(4)}  ${show(d)}`))
    process.exit(0)
  }

  const query = queryParts.join(' ').toLowerCase()

  const results = index.filter((c) => {
    if (domainFilter && !(c.domains || []).some((d) => d.includes(domainFilter))) return false
    if (roleFilter && !(c.roles || []).some((r) => r.includes(roleFilter)) &&
        !(c.profession || '').toLowerCase().includes(roleFilter)) return false
    if (confFilter && (c.confidence || 'none') !== confFilter) return false
    if (sourceFilter) {
      if (sourceFilter === 'multi') {
        if ((c.sources || []).length < 2) return false
      } else if (!(c.sources || []).includes(sourceFilter)) return false
    }
    if (tierFilter && c.tier !== tierFilter) return false
    return matchesQuery(c, query)
  })

  if (results.length === 0) {
    console.log('no matches')
    process.exit(0)
  }

  console.log(`${results.length} matches${results.length > limit ? ` (showing ${limit})` : ''}:\n`)

  for (const c of results.slice(0, limit)) {
    const prof = [c.profession, c.employer].filter(Boolean).join(' @ ')
    const sourceTag = (c.sources || []).map((s) => s[0].toUpperCase()).join('+')
    const handles = Object.entries(c.handles || {}).map(([p, h]) => `${p}:@${h}`).join(' ')
    const emails = (c.emails || []).slice(0, 2).join(', ')

    console.log(`  ${show(c.name)} [${sourceTag}] [${c.tier}] [${c.confidence}]`)
    if (prof) console.log(`    ${show(prof)}`)
    if (handles) console.log(`    ${show(handles)}`)
    if (emails) console.log(`    ${show(emails)}`)
    if (c.attested?.relationship) console.log(`    relationship: ${show(c.attested.relationship)}`)
    if ((c.domains || []).length) console.log(`    domains: ${show(c.domains.slice(0, 8).join(', '))}`)
    if ((c.labels || []).length) console.log(`    labels: ${show(c.labels.join(', '))}`)
    console.log()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
