// pattern: imperative-shell
// Convert a Facebook friends export (your_friends.html or friends JSON) into
// a normalized source file.
//
//   node scripts/convert-facebook.mjs [path/to/your_friends.html]
//
// Reads:  imports/your_friends.html (default; JSON also accepted)
// Writes: contacts/normalized/facebook.json (see docs/schema.md)
//
// Facebook friends carry name + friend-date only — thin by design. After
// converting and rebuilding, run the era-triage flow (CLAUDE.md step 4):
// the friend dates cluster by life era, and the owner's ten-second answers
// become attested facts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { stampSource } from './lib/envelope.mjs'
import { facebookFriendsRecords } from './lib/ingest.mjs'

const OUT_PATH = 'contacts/normalized/facebook.json'

function main() {
  const inPath = process.argv[2] || 'imports/your_friends.html'
  if (!existsSync(inPath)) {
    console.error(`No ${inPath} — drop your Facebook friends export there or pass a path.`)
    process.exit(1)
  }
  const { records, warnings } = facebookFriendsRecords(readFileSync(inPath, 'utf8'))
  for (const w of warnings) console.warn(w)
  if (records.length === 0) {
    console.error('0 records parsed — not writing.')
    process.exit(1)
  }
  mkdirSync('contacts/normalized', { recursive: true })
  writeFileSync(
    OUT_PATH,
    JSON.stringify(stampSource({ source: 'facebook', importedAt: new Date().toISOString().slice(0, 10), records }), null, 2),
  )
  const dates = records.map((r) => r.connectedOn).filter(Boolean).sort()
  console.log(`Wrote ${OUT_PATH} — ${records.length} friends (dates ${dates[0] || '?'} … ${dates[dates.length - 1] || '?'})`)
  console.log('Next: node scripts/build-index.mjs')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
