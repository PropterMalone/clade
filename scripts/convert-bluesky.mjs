// pattern: imperative-shell
// Ingest a Bluesky graph via the public atproto API — no export file, no login.
//
//   node scripts/convert-bluesky.mjs <handle>    # e.g. you.bsky.social
//
// Paginates app.bsky.graph.getFollows + getFollowers for <handle> on the public
// AppView, derives each account's mutual/following/follower edge from set
// membership, and writes contacts/normalized/bluesky.json. No app password: both
// lists are public reads, so users just pass their handle.
//
// LOCAL-ONLY: the cloud (claude.ai/code) sandbox's egress proxy blocks the
// Bluesky API host — run this on a local machine. Rebuild after:
// node scripts/build-index.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { stampSource } from './lib/envelope.mjs'
import { blueskyRecords } from './lib/ingest.mjs'
import { dataPath } from './paths.mjs'

const APPVIEW = 'https://public.api.bsky.app/xrpc'
const NORM_DIR = dataPath('contacts/normalized')
const OUT_PATH = dataPath('contacts/normalized/bluesky.json')

async function xrpc(method, params) {
  const url = `${APPVIEW}/${method}?${new URLSearchParams(params)}`
  for (let attempt = 1; ; attempt++) {
    let res
    try {
      res = await fetch(url, { headers: { accept: 'application/json' } })
    } catch (err) {
      if (attempt <= 3) {
        await new Promise((r) => setTimeout(r, attempt * 1000))
        continue
      }
      throw new Error(`${method}: network error after ${attempt} tries — ${err.message}`)
    }
    if (res.ok) return res.json()
    if (res.status === 429 && attempt <= 4) {
      const wait = Number.parseInt(res.headers.get('retry-after') || String(attempt * 2), 10) * 1000
      process.stderr.write(`\nrate limited — waiting ${wait / 1000}s…\n`)
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    throw new Error(`${method} → ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`)
  }
}

// Walk every page of a paginated list endpoint, accumulating `key`.
async function paginate(method, actor, key) {
  const out = []
  let cursor
  do {
    const page = await xrpc(method, { actor, limit: '100', ...(cursor ? { cursor } : {}) })
    out.push(...(page[key] || []))
    cursor = page.cursor
    process.stderr.write(`\r${method.split('.').pop()}: ${out.length}`)
  } while (cursor)
  process.stderr.write('\n')
  return out
}

async function main() {
  const handle = process.argv[2]
  if (!handle) {
    console.error('Usage: node scripts/convert-bluesky.mjs <handle>   (e.g. you.bsky.social)')
    process.exit(1)
  }
  console.log(`Fetching Bluesky graph for ${handle} …`)
  const [follows, followers] = await Promise.all([
    paginate('app.bsky.graph.getFollows', handle, 'follows'),
    paginate('app.bsky.graph.getFollowers', handle, 'followers'),
  ])
  const { records, warnings } = blueskyRecords(follows, followers)
  for (const w of warnings) console.warn(w)
  if (records.length === 0) {
    console.error(`0 accounts for ${handle} — is the handle spelled right and the account public?`)
    process.exit(1)
  }
  mkdirSync(NORM_DIR, { recursive: true })
  writeFileSync(
    OUT_PATH,
    JSON.stringify(stampSource({ source: 'bluesky', importedAt: new Date().toISOString().slice(0, 10), records }), null, 2),
  )
  const by = records.reduce((m, r) => ((m[r.edge] = (m[r.edge] || 0) + 1), m), {})
  console.log(
    `Wrote ${OUT_PATH} — ${records.length} accounts ` +
      `(${follows.length} follows, ${followers.length} followers; ` +
      `${by.mutual || 0} mutual, ${by.following || 0} following-only, ${by.follower || 0} follower-only)`,
  )
  console.log('Next: node scripts/build-index.mjs')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
