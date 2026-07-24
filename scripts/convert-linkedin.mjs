// pattern: imperative-shell
// Convert a LinkedIn Connections.csv export into a normalized source file.
//
//   node scripts/convert-linkedin.mjs [path/to/Connections.csv]
//
// Reads:  imports/Connections.csv (default)
// Writes: contacts/normalized/linkedin.json (see docs/schema.md)
//
// Parsing lives in scripts/lib/ingest.mjs (quote-aware CSV — "Acme, Inc."
// and "Barlow, CPA" stay in their columns). Rebuild after converting:
// node scripts/build-index.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { stampSource } from './lib/envelope.mjs'
import { linkedinRecords } from './lib/ingest.mjs'
import { dataPath } from './paths.mjs'

const OUT_PATH = dataPath('contacts/normalized/linkedin.json')

function main() {
  const csvPath = process.argv[2] || dataPath('imports/Connections.csv')
  if (!existsSync(csvPath)) {
    console.error(`No ${csvPath} — drop your LinkedIn export there or pass a path.`)
    process.exit(1)
  }
  const { records, warnings } = linkedinRecords(readFileSync(csvPath, 'utf8'))
  for (const w of warnings) console.warn(w)
  if (records.length === 0) {
    console.error('0 records parsed — not writing. Check the file is a LinkedIn Connections.csv.')
    process.exit(1)
  }
  mkdirSync(dataPath('contacts/normalized'), { recursive: true })
  writeFileSync(
    OUT_PATH,
    JSON.stringify(stampSource({ source: 'linkedin', importedAt: new Date().toISOString().slice(0, 10), records }), null, 2),
  )
  const withEmployer = records.filter((r) => r.employer).length
  console.log(`Wrote ${OUT_PATH} — ${records.length} records (${withEmployer} with employer)`)
  console.log('Next: node scripts/build-index.mjs')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
