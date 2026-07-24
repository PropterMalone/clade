// pattern: imperative-shell
// Convert a vCard (.vcf) export — Apple Contacts.app / iCloud, Google, Outlook —
// into a normalized source file.
//
//   node scripts/convert-vcard.mjs [path/to/contacts.vcf ...]
//
// Reads:  imports/contacts.vcf (default), or every .vcf path you pass
// Writes: contacts/normalized/vcard.json (see docs/schema.md)
//
// Handles RFC-6350 line folding, Apple itemN grouping, \-escaped values, and
// multi-valued email/phone/url; drops PHOTO blobs. Merge several address books
// in one file by passing them all: node scripts/convert-vcard.mjs a.vcf b.vcf
// Rebuild after: node scripts/build-index.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { stampSource } from './lib/envelope.mjs'
import { vcardRecords } from './lib/ingest.mjs'
import { dataPath } from './paths.mjs'

const OUT_PATH = dataPath('contacts/normalized/vcard.json')

function main() {
  const args = process.argv.slice(2)
  const inputs = args.length ? args : [dataPath('imports/contacts.vcf')]
  const present = inputs.filter((p) => existsSync(p))
  if (present.length === 0) {
    console.error(`No ${inputs.join(', ')} — drop your .vcf export there or pass a path.`)
    process.exit(1)
  }
  for (const p of inputs) if (!existsSync(p)) console.warn(`skipping missing ${p}`)
  const text = present.map((p) => readFileSync(p, 'utf8')).join('\n')
  const { records, warnings } = vcardRecords(text)
  for (const w of warnings) console.warn(w)
  if (records.length === 0) {
    console.error('0 records parsed — not writing.')
    process.exit(1)
  }
  mkdirSync(dataPath('contacts/normalized'), { recursive: true })
  writeFileSync(
    OUT_PATH,
    JSON.stringify(stampSource({ source: 'vcard', importedAt: new Date().toISOString().slice(0, 10), records }), null, 2),
  )
  const withEmail = records.filter((r) => r.emails.length).length
  const withPhone = records.filter((r) => r.phones.length).length
  console.log(`Wrote ${OUT_PATH} — ${records.length} contacts (${withEmail} with email, ${withPhone} with phone)`)
  console.log('Next: node scripts/build-index.mjs')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
