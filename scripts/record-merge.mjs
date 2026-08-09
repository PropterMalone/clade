// pattern: imperative-shell
// Record one human merge ruling into contacts/merge-decisions.json THROUGH the
// CLADE_DATA_DIR seam. Like attest.mjs, this exists because the merge-review
// pipeline has the operating Claude session write rulings directly — and a raw
// Write to a bare path would land in cwd (the public repo) instead of the data
// dir, so the ruling never reaches build-index. Invoke this instead of editing
// the file by hand.
//
//   node scripts/record-merge.mjs --keys "gmail:jwilson,facebook:jane-em" --verdict same
//   node scripts/record-merge.mjs --keys "linkedin:john-smith-ibm,facebook:john-smith-1987" --verdict different
//
// "same" forces a merge; "different" suppresses the pair from auto-merge and
// future candidate lists. A ruling on an already-decided pair updates its
// verdict. See docs/schema.md §2 (merge-decisions.json).

import { pathToFileURL } from 'node:url'
import { unwrapDecisions, wrapDecisions } from './lib/envelope.mjs'
import { updateJsonFile } from './overlay-write.mjs'
import { dataPath } from './paths.mjs'

const DECISIONS_PATH = dataPath('contacts/merge-decisions.json')

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

// Order-independent identity for a pair, so a re-ruling matches regardless of
// which key was listed first.
const pairId = (keys) => [...keys].sort().join('\u0000')

function main() {
  const keysArg = flag('--keys')
  const verdict = flag('--verdict')
  const keys = (keysArg ?? '').split(',').map((k) => k.trim()).filter(Boolean)
  if (keys.length !== 2 || !keys.every((k) => k.includes(':'))) {
    console.error('Usage: record-merge.mjs --keys "<source:id>,<source:id>" --verdict same|different')
    console.error('--keys must be exactly two "<source>:<sourceId>" record keys.')
    process.exit(1)
  }
  if (verdict !== 'same' && verdict !== 'different') {
    console.error('--verdict must be "same" or "different".')
    process.exit(1)
  }

  // One locked read-modify-write: merge review offers bulk rulings ("47
  // exact-name pairs — merge them all?"), so concurrent invocations are the
  // normal case, not the exotic one. Unlocked, each reads the same version and
  // the last writer wins — a ruling vanishes while both processes report success.
  let outcome
  updateJsonFile(
    DECISIONS_PATH,
    (raw) => {
      const decisions = unwrapDecisions(raw)
      const id = pairId(keys)
      const existing = decisions.find((d) => Array.isArray(d.keys) && pairId(d.keys) === id)
      if (existing) {
        existing.verdict = verdict
        outcome = 'Updated'
      } else {
        decisions.push({ keys, verdict })
        outcome = 'Recorded'
      }
      return wrapDecisions(decisions)
    },
    [],
  )
  console.log(`${outcome} ruling: ${keys.join(' + ')} → ${verdict}`)
  console.log(`→ ${DECISIONS_PATH}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
