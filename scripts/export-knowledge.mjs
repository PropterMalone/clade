// pattern: imperative-shell
// Export the unified index as compact markdown for a claude.ai Project.
//
//   node scripts/export-knowledge.mjs
//
// Writes contacts/rolodex-knowledge.md — one line-block per person, readable
// prose rather than JSON, because Project-knowledge retrieval matches human
// phrasing ("who do I know in healthcare?") against text, not structure.
// Upload it to a claude.ai Project ("My Rolodex") and every Claude surface —
// including the mobile app — becomes the query engine. Re-export and replace
// the Project file after enrichment or triage sessions.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { clean, isKeyShapedName } from './lib/enrich-core.mjs'
import { dataPath } from './paths.mjs'

const INDEX_PATH = dataPath('contacts/unified-index.json')
const OUT_PATH = dataPath('contacts/rolodex-knowledge.md')

// Skip non-person artifacts, by reason:
//   key-shaped — "linkedin:jane-wilson": a record key that leaked in as a name
//   shortcode  — "#BAL - Check Balance": carrier/service artifacts
//   no-letters — "12345": nothing queryable
// A digit-start handle like "420blaze_dave" is a real contact and is kept.
export function skipReason(name) {
  if (isKeyShapedName(name)) return 'key-shaped'
  if (/^[#*]/.test(name || '')) return 'shortcode'
  if (!/\p{L}/u.test(name || '')) return 'no-letters'
  return null
}

// One line, no control chars: these fields feed a markdown file that a second
// Claude session treats as trusted knowledge (angel-review C6).
const line = (s) => clean(s, 1000).replace(/\s+/g, ' ').trim()

function main() {
  if (!existsSync(INDEX_PATH)) {
    console.error(`No ${INDEX_PATH} — run: node scripts/build-index.mjs`)
    process.exit(1)
  }
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'))

  const lines = []
  const skipped = { 'key-shaped': 0, shortcode: 0, 'no-letters': 0 }
  for (const c of index) {
    const skip = skipReason(c.name)
    if (skip) {
      skipped[skip]++
      continue
    }
    const parts = []
    const prof = [c.profession, c.employer].filter(Boolean).join(' at ')
    if (prof) parts.push(prof)
    if (c.attested?.relationship) parts.push(`relationship: ${c.attested.relationship}`)
    if (c.attested?.context) parts.push(c.attested.context)
    if ((c.domains || []).length) parts.push(`expertise: ${c.domains.join(', ')}`)
    if ((c.labels || []).length) parts.push(`labels: ${c.labels.join(', ')}`)
    const contact = [
      ...(c.emails || []).slice(0, 2),
      ...Object.entries(c.handles || {}).map(([p, h]) => `${p} @${h}`),
      c.linkedinUrl,
    ].filter(Boolean)
    if (contact.length) parts.push(`contact: ${contact.join(', ')}`)
    if (c.notes) parts.push(c.notes)
    const conn = Object.entries(c.connectedOn || {})
      .map(([s, d]) => `${s} ${d}`)
      .join('; ')
    if (conn) parts.push(`connected: ${conn}`)

    lines.push(`## ${line(c.name)}`)
    lines.push(line(parts.join('. ')) || '(no details yet)')
    lines.push('')
  }

  const totalSkipped = Object.values(skipped).reduce((a, b) => a + b, 0)
  const header = [
    '# Personal rolodex',
    '',
    `${index.length - totalSkipped} contacts, exported ${new Date().toISOString().slice(0, 10)}.`,
    'Each entry: who they are, what they do, how the owner knows them.',
    '',
  ]
  writeFileSync(OUT_PATH, [...header, ...lines].join('\n'))
  const kb = (Buffer.byteLength([...header, ...lines].join('\n')) / 1024).toFixed(0)
  const skipDetail = Object.entries(skipped).filter(([, n]) => n > 0).map(([r, n]) => `${n} ${r}`).join(', ')
  console.log(`Wrote ${OUT_PATH} — ${index.length - totalSkipped} contacts (skipped: ${skipDetail || 'none'}), ${kb} KB`)
  console.log('Upload/replace it in your claude.ai Project to refresh phone-side queries.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
