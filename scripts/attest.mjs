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
//     [--domains "nursing,healthcare"] [--real-name "Jane Emerson"] \
//     [--location "Evanston, IL"]
//
// Only the fields you pass are set; existing fields on the entry are preserved.
// All fields are optional except --key. See docs/schema.md §2 (attested.json).

import { pathToFileURL } from 'node:url'
import { looksLikeStreetAddress } from './lib/enrich-core.mjs'
import { unwrapEntries, wrapEntries } from './lib/envelope.mjs'
import { expectEntryMap, updateJsonFile } from './overlay-write.mjs'
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
    console.error('Usage: attest.mjs --key <source:sourceId> [--relationship ..] [--context ..] [--domains a,b] [--real-name ..] [--location ..]')
    console.error('--key is required and must be a "<source>:<sourceId>" record key.')
    process.exit(1)
  }

  // Build the UPDATES from flags before touching the file: everything below is
  // pure argument handling, and holding the lock across it would serialize
  // callers for no reason. The read-modify-write happens in one locked step
  // afterwards.
  const updates = {}

  const relationship = flag('--relationship')
  const context = flag('--context')
  const domains = flag('--domains')
  const realName = flag('--real-name')
  // A city/region, not a street address: the owner saying "they live in Chicago"
  // outranks both a stale export and web research (ADR-10). Street addresses
  // come from address-book ingest, not from triage.
  const location = flag('--location')
  if (relationship !== undefined) updates.relationship = relationship
  if (context !== undefined) updates.context = context
  if (domains !== undefined) updates.domains = domains.split(',').map((d) => d.trim()).filter(Boolean)
  if (realName !== undefined) updates.realName = realName
  if (location !== undefined) {
    // Refuse loudly rather than silently storing a street address in the field
    // that IS allowed to travel (ADR-10). The owner typed this, so tell them
    // where it belongs instead of dropping it — attest.mjs is the only producer
    // of `location` with a human on the other end.
    if (looksLikeStreetAddress(location)) {
      console.error(`Refusing --location ${JSON.stringify(location)}: that looks like a street address.`)
      console.error('`location` is the SHAREABLE grade — it reaches enrichment prompts, the Project export, and the MCP seam.')
      console.error('Pass a city/region ("Evanston, IL"). Street addresses belong in a record\'s addresses[], via address-book ingest.')
      process.exit(1)
    }
    updates.location = location
  }

  // Checked against the FLAGS, not the merged entry: for an existing key with no
  // flags the merged entry is non-empty, so the old check didn't fire and the
  // file was rewritten unchanged while printing "Attested" — a success message
  // with nothing behind it.
  if (Object.keys(updates).length === 0) {
    console.error('Nothing to attest — pass at least one of --relationship/--context/--domains/--real-name/--location.')
    process.exit(1)
  }

  // Read and write inside ONE lock. Locking only the write would still lose
  // updates: it is the STALE READ that makes a sibling's entry disappear, and
  // triage batches invite exactly that (a session firing per-key calls in
  // parallel because different --key values look independent).
  let entry
  updateJsonFile(
    ATTESTED_PATH,
    (raw) => {
      const entries = unwrapEntries(raw)
      entry = { ...(entries[key] ?? {}), ...updates }
      entries[key] = entry
      return wrapEntries(entries)
    },
    {},
    { validate: expectEntryMap },
  )
  console.log(`Attested ${key} → ${ATTESTED_PATH}`)
  console.log(JSON.stringify(entry, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
