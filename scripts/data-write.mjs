// pattern: imperative-shell
// Write stdin to a file UNDER the CLADE_DATA_DIR data root — the enforced escape
// hatch for the agent-direct writes that aren't a structured overlay entry:
// profile/about-me.md (first-run interview), contacts/normalized/manual.json
// (quick-add), and contacts/enrichments/*.json (the cloud-sandbox enrichment
// fallback). The operating Claude session pipes content here instead of using a
// raw Write to a bare path, so the file lands in the data dir rather than the
// session's cwd (the public engine repo in the CLADE_DATA_DIR workflow).
//
//   echo "$CONTENT" | node scripts/data-write.mjs profile/about-me.md
//   cat batch.json  | node scripts/data-write.mjs contacts/enrichments/batch-x.json
//
// The target must be RELATIVE and stay under one of the data roots
// (contacts/, imports/, profile/); traversal (..) or an absolute target is
// refused. Parent directories are created.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dataRoot } from './paths.mjs'

const ALLOWED_ROOTS = ['contacts', 'imports', 'profile']

// Synchronous full drain of stdin (fd 0). readFileSync(0) is the ESM-clean idiom.
const readStdin = () => readFileSync(0)

function main() {
  const target = process.argv[2]
  if (!target) {
    console.error('Usage: <content on stdin> | node scripts/data-write.mjs <relative/path/under/data/root>')
    process.exit(1)
  }
  if (isAbsolute(target)) {
    console.error(`Refusing absolute target: ${target} — pass a path relative to the data root.`)
    process.exit(1)
  }

  const root = dataRoot()
  const abs = join(root, target)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    console.error(`Refusing target outside the data root: ${target}`)
    process.exit(1)
  }
  const top = rel.split(sep)[0]
  if (!ALLOWED_ROOTS.includes(top)) {
    console.error(`Refusing target outside data roots (${ALLOWED_ROOTS.join('/, ')}/): ${target}`)
    process.exit(1)
  }

  const content = readStdin()
  const parent = abs.slice(0, abs.lastIndexOf(sep))
  mkdirSync(parent, { recursive: true })
  writeFileSync(abs, content)
  console.log(`Wrote ${content.length} bytes → ${abs}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
