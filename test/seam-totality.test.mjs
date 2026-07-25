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

// Shells are ENUMERATED, not listed: a hardcoded list only scans files someone
// remembered to add — the same someone who forgot dataPath(). paths.mjs is the
// seam itself (exempt); lib/* is path-free by contract (not scanned).
const EXEMPT = new Set(['paths.mjs'])
const SHELLS = [
  ...readdirSync(join(ROOT, 'scripts'))
    .filter((f) => f.endsWith('.mjs') && !EXEMPT.has(f))
    .map((f) => `scripts/${f}`),
  'search.mjs',
]

// Quote forms: ' " and backtick (template literals interpolate data paths too),
// with an optional ./ prefix — all evade a naive quote-flush-to-keyword regex.
const DATA_LITERAL = /['"`]\.?\/?(contacts|imports|profile)\//
// A dataPath('contacts/…') argument in any quote form — the allowed shape.
const WRAPPED = /dataPath\(\s*['"`]\.?\/?(contacts|imports|profile)\/[^'"`]*['"`]/g

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
  // Prove the regex catches the failures it exists to catch, so a future edit
  // can't neuter the guard without this test noticing. Each evasion form here
  // slipped past the original quote-flush-to-keyword regex.
  const caught = (src) => DATA_LITERAL.test(src.replace(WRAPPED, 'dataPath(_)'))
  assert.ok(caught("const OUT = 'contacts/unified-index.json'"), 'single-quoted')
  assert.ok(caught('const OUT = "imports/Connections.csv"'), 'double-quoted')
  assert.ok(caught('const OUT = `contacts/enrichments/${f}`'), 'template literal')
  assert.ok(caught("const OUT = './contacts/attested.json'"), './-prefixed')
  assert.ok(caught("readFileSync('profile/about-me.md')"), 'inline arg')
  // …and does NOT fire on the allowed wrapped form, in any quote style.
  assert.ok(!caught("const OUT = dataPath('contacts/unified-index.json')"), 'wrapped single')
  assert.ok(!caught('const OUT = dataPath("imports/Connections.csv")'), 'wrapped double')
})

test('the shell list is enumerated, so a new shell is scanned automatically', () => {
  // Guards the guard: if this ever reverts to a hardcoded list, a newly added
  // script silently stops being checked — the exact gap the seam can't afford.
  assert.ok(SHELLS.includes('scripts/build-index.mjs'))
  assert.ok(SHELLS.includes('search.mjs'))
  assert.ok(!SHELLS.includes('scripts/paths.mjs'), 'the seam itself is exempt')
  const scripts = readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs'))
  // every scripts/*.mjs except paths.mjs (exempt), plus search.mjs at the root
  assert.equal(SHELLS.length, scripts.length - EXEMPT.size + 1)
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
