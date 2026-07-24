// pattern: imperative-shell
// Convert a Google Contacts CSV export (takeout.google.com → Contacts) into
// a normalized source file.
//
//   node scripts/convert-google.mjs [path/to/contacts.csv]
//
// Reads:  imports/google-contacts.csv (default)
// Writes: contacts/normalized/google-contacts.json (see docs/schema.md)
//
// Handles " ::: " multi-value cells, keeps group labels as labels (not
// emails), validates addresses. Rebuild after: node scripts/build-index.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { stampSource } from './lib/envelope.mjs'
import { googleContactsRecords } from './lib/ingest.mjs'
import { dataPath } from './paths.mjs'

const OUT_PATH = dataPath('contacts/normalized/google-contacts.json')

function main() {
  const inPath = process.argv[2] || dataPath('imports/google-contacts.csv')
  if (!existsSync(inPath)) {
    console.error(`No ${inPath} — drop your Google Contacts CSV there or pass a path.`)
    process.exit(1)
  }
  const { records, warnings } = googleContactsRecords(readFileSync(inPath, 'utf8'))
  for (const w of warnings) console.warn(w)
  if (records.length === 0) {
    console.error('0 records parsed — not writing.')
    process.exit(1)
  }
  mkdirSync(dataPath('contacts/normalized'), { recursive: true })
  writeFileSync(
    OUT_PATH,
    JSON.stringify(stampSource({ source: 'google-contacts', importedAt: new Date().toISOString().slice(0, 10), records }), null, 2),
  )
  const withEmail = records.filter((r) => r.emails.length).length
  const withLabels = records.filter((r) => r.labels.length).length
  console.log(`Wrote ${OUT_PATH} — ${records.length} contacts (${withEmail} with email, ${withLabels} with labels)`)
  console.log('Next: node scripts/build-index.mjs')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
