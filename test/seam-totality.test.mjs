// pattern: functional-core
// Seam-totality guard: every data-path literal in an imperative shell must be
// routed through dataPath() (the CLADE_DATA_DIR seam) — a bare 'contacts/…',
// 'imports/…', or 'profile/…' literal would silently resolve against cwd (the
// public engine repo in the CLADE_DATA_DIR workflow) instead of the data dir.
// The failure is SILENT (writes land gitignored-but-out-of-place; reads come
// back empty), so a one-time manual sweep isn't enough — this is the mechanical
// gate that keeps the seam total as new shells are added. See paths.mjs and
// docs/decisions/06.
//
// Plus one end-to-end integration test: a shell spawned with CLADE_DATA_DIR set
// must write into the data dir, not the repo — the behavior the unit tests of
// the pure resolver can't prove.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Files that resolve data paths. paths.mjs is the seam itself (exempt); lib/* is
// path-free by contract (not scanned). Add new shells here.
const SHELLS = [
  'scripts/build-index.mjs',
  'scripts/enrich-batch.mjs',
  'scripts/cue-tag.mjs',
  'scripts/export-knowledge.mjs',
  'scripts/attest.mjs',
  'scripts/record-merge.mjs',
  'scripts/data-write.mjs',
  'scripts/convert-linkedin.mjs',
  'scripts/convert-google.mjs',
  'scripts/convert-facebook.mjs',
  'scripts/convert-vcard.mjs',
  'scripts/convert-bluesky.mjs',
  'search.mjs',
]

const DATA_LITERAL = /['"](contacts|imports|profile)\//
// A dataPath('contacts/…') / dataPath("imports/…") argument — the allowed shape.
const WRAPPED = /dataPath\(\s*['"](contacts|imports|profile)\/[^'"]*['"]/g

test('every data-path literal in a shell is routed through dataPath()', () => {
  const violations = []
  for (const rel of SHELLS) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith('//')) return // comment line
      // Remove the allowed dataPath('…') wrappers, then any surviving data
      // literal on this line is a stray bare path.
      const stripped = line.replace(WRAPPED, 'dataPath(_)')
      if (DATA_LITERAL.test(stripped)) {
        violations.push(`${rel}:${i + 1}: ${line.trim()}`)
      }
    })
  }
  assert.equal(
    violations.length,
    0,
    `Bare data-path literal(s) not wrapped in dataPath() — they would bypass CLADE_DATA_DIR:\n${violations.join('\n')}`,
  )
})

test('a new stray literal WOULD be caught (guard self-check)', () => {
  // Prove the regex catches the failure it exists to catch, so a future edit
  // can't neuter the guard without this test noticing.
  const bad = "const OUT = 'contacts/unified-index.json'"
  assert.ok(DATA_LITERAL.test(bad.replace(WRAPPED, 'dataPath(_)')))
  const good = "const OUT = dataPath('contacts/unified-index.json')"
  assert.ok(!DATA_LITERAL.test(good.replace(WRAPPED, 'dataPath(_)')))
})

test('CLADE_DATA_DIR redirects a shell end-to-end (build-index writes the data dir, not the repo)', () => {
  const dd = mkdtempSync(join(tmpdir(), 'clade-seam-'))
  const norm = join(dd, 'contacts', 'normalized')
  execFileSync('node', ['-e', `require('fs').mkdirSync(${JSON.stringify(norm)},{recursive:true})`])
  writeFileSync(
    join(norm, 'manual.json'),
    JSON.stringify({
      schemaVersion: 1,
      source: 'manual',
      records: [{ sourceId: 'x', name: 'Test Person', emails: ['t@example.com'] }],
    }),
  )

  execFileSync('node', ['scripts/build-index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, CLADE_DATA_DIR: dd },
  })

  // The index landed in the data dir...
  const index = JSON.parse(readFileSync(join(dd, 'contacts', 'unified-index.json'), 'utf8'))
  const names = (index.contacts ?? index.entries ?? index).map?.((c) => c.name) ?? []
  assert.ok(JSON.stringify(index).includes('Test Person'), 'data-dir index should contain the seeded person')

  // ...and the repo's own contacts/ has no unified-index.json from this run.
  const repoContacts = readdirSync(join(ROOT, 'contacts'))
  // (repo may hold pre-existing gitignored dev data; assert only that THIS run's
  // temp person didn't leak into a repo file.)
  for (const f of repoContacts) {
    if (!f.endsWith('.json')) continue
    const body = readFileSync(join(ROOT, 'contacts', f), 'utf8')
    assert.ok(!body.includes('t@example.com'), `seeded data leaked into repo contacts/${f}`)
  }
  void names
})
