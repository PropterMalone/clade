// pattern: imperative-shell
// Upsert one user-attested fact into contacts/attested.json THROUGH the
// CLADE_DATA_DIR seam. This exists because the pipeline (triage, quick-add) has
// the operating Claude session record attested facts — and an env var cannot
// govern a raw Write-tool call, so a bare `contacts/attested.json` edit would
// land in the session's cwd (the public engine repo in the CLADE_DATA_DIR
// workflow) while build-index reads the data dir: the ruling "saves" but never
// reaches the index. Invoke this instead of hand-editing the file.
//
//   node scripts/attest.mjs --key facebook:jane-em \
//     --relationship "college roommate's wife" \
//     --context "Met at State U ~2008; lives in Chicago" \
//     [--domains "nursing,healthcare"] [--real-name "Jane Emerson"]
//
// Only the fields you pass are set; existing fields on the entry are preserved.
// All fields are optional except --key. See docs/schema.md §2 (attested.json).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { unwrapEntries, wrapEntries } from './lib/envelope.mjs'
import { dataPath } from './paths.mjs'

const ATTESTED_PATH = dataPath('contacts/attested.json')

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function main() {
  const key = flag('--key')
  if (!key || !key.includes(':')) {
    console.error('Usage: attest.mjs --key <source:sourceId> [--relationship ..] [--context ..] [--domains a,b] [--real-name ..]')
    console.error('--key is required and must be a "<source>:<sourceId>" record key.')
    process.exit(1)
  }

  const raw = existsSync(ATTESTED_PATH) ? JSON.parse(readFileSync(ATTESTED_PATH, 'utf8')) : {}
  const entries = unwrapEntries(raw)
  const entry = { ...(entries[key] ?? {}) }

  const relationship = flag('--relationship')
  const context = flag('--context')
  const domains = flag('--domains')
  const realName = flag('--real-name')
  if (relationship !== undefined) entry.relationship = relationship
  if (context !== undefined) entry.context = context
  if (domains !== undefined) entry.domains = domains.split(',').map((d) => d.trim()).filter(Boolean)
  if (realName !== undefined) entry.realName = realName

  if (Object.keys(entry).length === 0) {
    console.error('Nothing to attest — pass at least one of --relationship/--context/--domains/--real-name.')
    process.exit(1)
  }

  entries[key] = entry
  writeFileSync(ATTESTED_PATH, `${JSON.stringify(wrapEntries(entries), null, 2)}\n`)
  console.log(`Attested ${key} → ${ATTESTED_PATH}`)
  console.log(JSON.stringify(entry, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
