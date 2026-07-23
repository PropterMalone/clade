// pattern: functional-core
// schemaVersion envelopes for the overlay + normalized files (docs/schema.md §5.6).
//
// Set before Clade goes multi-user: stamping a version now (data dirs are empty)
// is nearly free, whereas retrofitting it later across many users' independent
// datasets is the expensive path. A future migrator upgrades older data by
// reading schemaVersion.
//
// Readers accept exactly TWO shapes and fail LOUD on anything else. The two valid
// shapes are (1) a bare legacy map/array (un-versioned, hand-written before the
// envelope) and (2) the wrapped envelope. Detection is unambiguous because
// entry-map keys are always "<source>:<sourceId>" (contain ":"), so a top-level
// "entries"/"schemaVersion" key can never be a real record key. A well-formed-JSON
// file of the WRONG shape (typo'd payload key, entries:null, a bare record key
// stranded beside "entries", a newer schemaVersion) throws instead of silently
// collapsing to empty — the old code threw here too, and silently dropping the
// owner's irreplaceable rulings/attestations is the failure this guards
// (angel-review).

export const SCHEMA_VERSION = 1

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v)

function assertVersion(raw) {
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `schemaVersion ${raw.schemaVersion} is newer than this build supports (${SCHEMA_VERSION}) — upgrade Clade`,
    )
  }
}

// Entry-map overlays: enrichments/*.json, attested.json.
// Wrapped: { schemaVersion, entries: { "<key>": {…} } }. Bare: { "<key>": {…} }.
export function unwrapEntries(raw) {
  if (!isPlainObject(raw)) return {}
  const wrapped = 'entries' in raw || 'schemaVersion' in raw
  if (!wrapped) return raw // bare legacy map (record keys all contain ":")
  assertVersion(raw)
  if (!isPlainObject(raw.entries)) {
    throw new Error('malformed schemaVersion envelope: expected an "entries" object')
  }
  // A record key ("<source>:<sourceId>") sitting at the top level beside "entries"
  // is a hand-edit that appended to a wrapped file the bare way — it would be
  // silently dropped. Refuse, naming the stranded key so the owner can move it.
  const stranded = Object.keys(raw).filter((k) => k.includes(':'))
  if (stranded.length) {
    throw new Error(
      `record key(s) ${stranded.join(', ')} are outside "entries" — move them inside the "entries" object`,
    )
  }
  return raw.entries
}

export const wrapEntries = (entries) => ({ schemaVersion: SCHEMA_VERSION, entries })

// merge-decisions.json: an array of rulings.
// Wrapped: { schemaVersion, decisions: [ … ] }. Bare: [ … ].
export function unwrapDecisions(raw) {
  if (Array.isArray(raw)) return raw // bare legacy array
  if (!isPlainObject(raw)) return [] // absent file → readJson default
  const wrapped = 'decisions' in raw || 'schemaVersion' in raw
  if (!wrapped) {
    throw new Error('merge-decisions.json must be an array or a { schemaVersion, decisions } envelope')
  }
  assertVersion(raw)
  if (!Array.isArray(raw.decisions)) {
    throw new Error('malformed schemaVersion envelope: expected a "decisions" array')
  }
  return raw.decisions
}

export const wrapDecisions = (decisions) => ({ schemaVersion: SCHEMA_VERSION, decisions })

// normalized/<source>.json is already a top-level object; schemaVersion rides as
// a sibling of source/importedAt/records. schemaVersion is placed LAST so it wins
// even if `obj` already carries one (e.g. a migrator re-stamping older data) —
// the stamp must reflect THIS build, not the input (angel-review).
export const stampSource = (obj) => ({ ...obj, schemaVersion: SCHEMA_VERSION })
