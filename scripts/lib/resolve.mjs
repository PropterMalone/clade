// pattern: functional-core
// Entity resolution + group folding for the unified contact index.
// Pure functions only — no fs, no process, no clock. Shell: scripts/build-index.mjs.
//
// Merge policy (docs/decisions/02): auto-merge only on shared strong
// identifiers (email, phone, handle, linkedin.com/in URL) or near-exact name +
// employer-token overlap. Everything else — including exact-name pairs that are
// unique in both sources but share no employer signal — goes to merge
// candidates for a human ruling. A "different" ruling blocks the whole
// person-pair transitively: the check runs against *current* union-find roots
// on every candidate comparison, so a third record can never bridge two ruled
// groups (angel-review C1).

// --- normalizers ------------------------------------------------------------

// Returns null for values that aren't plausibly an email — converters have
// leaked label strings ("* myContacts") and photo URLs into email fields, and
// two records sharing the same junk string must never merge on it.
export const normEmail = (e) => {
  const v = e.trim().toLowerCase()
  return v.includes('@') && !v.includes(' ') ? v : null
}

export const normPhone = (p) => {
  const digits = p.replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : null // last-10 match tolerates country codes
}

export const normLinkedin = (u) => {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(u)
  return m ? m[1].toLowerCase() : null
}

export function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export const nameTokens = (name) => normalizeName(name).split(' ').filter(Boolean)

export function nameMatch(a, b) {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1.0
  const ta = nameTokens(a)
  const tb = nameTokens(b)
  if (ta.length === 0 || tb.length === 0) return 0
  let shared = 0
  for (const t of ta) {
    for (const u of tb) {
      if (t === u) { shared++; break }
      if (t.length === 1 && u.startsWith(t)) { shared += 0.5; break }
      if (u.length === 1 && t.startsWith(u)) { shared += 0.5; break }
    }
  }
  const lastMatch = ta[ta.length - 1] === tb[tb.length - 1] ? 0.3 : 0
  return (shared / Math.max(ta.length, tb.length)) * 0.7 + lastMatch
}

// --- employer comparison -----------------------------------------------------

// Generic corporate suffix/glue words carry no identity signal — "Ford Motor
// Company" and "Acme Company" must not overlap on "company".
const EMPLOYER_STOPWORDS = new Set([
  'the', 'of', 'and', 'inc', 'llc', 'llp', 'ltd', 'co', 'corp', 'corporation',
  'company', 'group', 'gmbh', 'plc',
])

export const employerTokens = (r) => {
  const raw = `${r.employer || ''}`.toLowerCase()
  const set = new Set(
    raw.split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !EMPLOYER_STOPWORDS.has(t)),
  )
  if (set.size === 0) {
    // Short names tokenize to nothing ("3M" pre-fix, "AT&T" → at/t, "X"):
    // fall back to the compacted whole name so same-company still overlaps
    // instead of reading as a conflict (angel-review C4).
    const compact = raw.replace(/[^a-z0-9]/g, '')
    if (compact) set.add(compact)
  }
  return set
}

export const employerOverlap = (a, b) => {
  const ta = employerTokens(a)
  for (const t of employerTokens(b)) if (ta.has(t)) return true
  return false
}

// Employers conflict only when both are present and share no token — job
// changes make mismatched employers common, but that's still a conflict worth
// a human ruling rather than a silent merge.
export const employersConflict = (a, b) =>
  a.employer && b.employer && !employerOverlap(a, b)

// --- resolution --------------------------------------------------------------

// records: [{ key, source, name?, emails?, phones?, handles?, urls?, employer?, ... }]
// decisions: [{ keys: [a, b], verdict: 'same' | 'different' }]
// Returns { groups, candidates, warnings } — groups is an array of record arrays.
export function resolveRecords(records, decisions = []) {
  const warnings = []
  const parent = records.map((_, i) => i)
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  function union(a, b) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  const keyToIdx = new Map(records.map((r, i) => [r.key, i]))

  // strong-identifier edges
  //
  // Phones and emails are routinely shared BETWEEN people — household
  // landlines, couples' inboxes, a front-desk number on several cards — so a
  // collision on them is only trusted when the names corroborate. When both
  // records carry multi-token names that share nothing, the pair is deferred
  // to merge-candidates for a human ruling instead of silently gluing two
  // people. Single-token/blank names ("jwilson" ↔ "Jennifer Wilson") still
  // auto-merge: no conflict evidence, and those merges are usually right.
  // Handles and linkedin.com/in URLs are single-person platform identities
  // and stay fully authoritative (a clashing name there only warns).
  const CORROBORATION_REQUIRED = new Set(['email', 'phone'])
  // Phone/email collisions auto-merge only when the names genuinely agree.
  // A shared surname is NOT agreement — spouses, siblings, and parent/child
  // share a landline AND a surname (the most common real household case), and
  // partial nameMatch credit for one shared token must never count as
  // corroboration (angel-review 2026-07-19 Critical). Single-token/blank
  // names carry no conflict evidence ("jwilson" ↔ "Jennifer Wilson") and
  // still pass.
  const namesCorroborate = (a, b) => {
    if (nameTokens(a.name).length < 2 || nameTokens(b.name).length < 2) return true
    return nameMatch(a.name, b.name) >= 0.8
  }
  const namesDisagree = (a, b) =>
    nameTokens(a.name).length >= 2 && nameTokens(b.name).length >= 2 &&
    nameMatch(a.name, b.name) === 0
  const deferredPairs = [] // { i, j, type, value } — decided after rulings load
  const byIdentifier = new Map() // "type:value" -> first record idx
  function link(idx, type, value) {
    if (!value) return
    const k = `${type}:${value}`
    if (!byIdentifier.has(k)) {
      byIdentifier.set(k, idx)
      return
    }
    const other = byIdentifier.get(k)
    const a = records[other]
    const b = records[idx]
    if (CORROBORATION_REQUIRED.has(type)) {
      if (!namesCorroborate(a, b)) {
        deferredPairs.push({ i: other, j: idx, type, value })
        return
      }
    } else if (namesDisagree(a, b)) {
      warnings.push(
        `strong identifier ${type} merges "${a.name}" (${a.key}) with "${b.name}" (${b.key}) — names share no tokens; verify`,
      )
    }
    union(other, idx)
  }

  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    for (const e of r.emails || []) {
      if (typeof e !== 'string' || !e.trim()) {
        warnings.push(`${r.key}: skipping non-string/empty email ${JSON.stringify(e)}`)
        continue
      }
      link(i, 'email', normEmail(e))
    }
    for (const p of r.phones || []) {
      if (typeof p !== 'string' || !p.trim()) {
        warnings.push(`${r.key}: skipping non-string/empty phone ${JSON.stringify(p)}`)
        continue
      }
      link(i, 'phone', normPhone(p))
    }
    for (const [platform, handle] of Object.entries(r.handles || {})) {
      // Non-string placeholders (null, 0, {}) would stringify to truthy junk
      // like "null" and false-merge every record carrying them (angel-review C5).
      if (typeof handle !== 'string' || !handle.trim()) {
        if (handle != null) warnings.push(`${r.key}: skipping non-string ${platform} handle ${JSON.stringify(handle)}`)
        continue
      }
      link(i, `handle-${platform}`, handle.trim().toLowerCase())
    }
    for (const u of r.urls || []) {
      if (typeof u !== 'string') continue
      link(i, 'linkedin', normLinkedin(u))
    }
    // atproto DID: cryptographic identity key — two records sharing a DID are
    // the same identity by construction (ADR-04). Fully authoritative, like
    // handles; the stable anchor for future self-published Clade profiles.
    if (typeof r.did === 'string' && /^did:[a-z0-9]+:.+/i.test(r.did.trim())) link(i, 'did', r.did.trim())
  }

  // human rulings override everything fuzzy
  const blockedIdxPairs = []
  for (const d of decisions) {
    const [a, b] = d.keys || []
    const ia = keyToIdx.get(a)
    const ib = keyToIdx.get(b)
    if (ia == null || ib == null) {
      warnings.push(`merge-decisions ruling references unknown key(s): ${a} / ${b} — no effect`)
      continue
    }
    if (d.verdict === 'same') union(ia, ib)
    if (d.verdict === 'different') blockedIdxPairs.push([ia, ib])
  }
  for (const [ia, ib] of blockedIdxPairs) {
    if (find(ia) === find(ib)) {
      warnings.push(
        `"different" ruling on ${records[ia].key} / ${records[ib].key} conflicts with a strong-identifier or "same" merge that already joined them — review`,
      )
    }
  }

  // A "different" ruling blocks the whole person-pair. Checked against the
  // *current* roots on every comparison — never a precomputed snapshot — so
  // fuzzy unions during the pass can't bridge two blocked groups via a third
  // record (angel-review C1).
  function isBlocked(i, j) {
    const ri = find(i)
    const rj = find(j)
    for (const [ia, ib] of blockedIdxPairs) {
      const ra = find(ia)
      const rb = find(ib)
      if ((ra === ri && rb === rj) || (ra === rj && rb === ri)) return true
    }
    return false
  }

  // Exact-name handling needs uniqueness: count each normalized full name per
  // source. Two LinkedIn "Alex Sierra"s mean every Alex Sierra pair stays a
  // candidate for human review.
  const nameCountBySource = new Map() // source -> Map(normName -> count)
  for (const r of records) {
    const nn = normalizeName(r.name)
    if (!nn) continue
    if (!nameCountBySource.has(r.source)) nameCountBySource.set(r.source, new Map())
    const m = nameCountBySource.get(r.source)
    m.set(nn, (m.get(nn) || 0) + 1)
  }
  const uniqueInSource = (r) =>
    nameCountBySource.get(r.source)?.get(normalizeName(r.name)) === 1

  // fuzzy name pass, blocked by last-name token to stay tractable at 10k+ records
  const blocks = new Map()
  for (let i = 0; i < records.length; i++) {
    const t = nameTokens(records[i].name)
    if (t.length === 0) continue
    const last = t[t.length - 1]
    if (!blocks.has(last)) blocks.set(last, [])
    blocks.get(last).push(i)
  }

  const candidates = []
  const candidateGroupPairs = new Set() // dedupe: one row per person-pair, not per record-pair

  // Deferred phone/email collisions: legitimately shared identifiers
  // (household landlines, shared inboxes, one number on several of the
  // owner's own cards) surface for a ruling instead of silently merging.
  for (const d of deferredPairs) {
    if (find(d.i) === find(d.j)) continue // merged via another identifier or a "same" ruling
    if (isBlocked(d.i, d.j)) continue
    const groupPair = [find(d.i), find(d.j)].sort((p, q) => p - q).join('|')
    if (candidateGroupPairs.has(groupPair)) continue
    candidateGroupPairs.add(groupPair)
    const a = records[d.i]
    const b = records[d.j]
    candidates.push({
      keys: [a.key, b.key],
      names: [a.name, b.name],
      employers: [a.employer || '', b.employer || ''],
      score: 0,
      reason: `shared-${d.type}`,
      identifier: `${d.type}:${d.value}`,
    })
  }

  for (const idxs of blocks.values()) {
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const i = idxs[x]
        const j = idxs[y]
        const a = records[i]
        const b = records[j]
        if (a.source === b.source) continue // within-source dupes are the source's problem
        if (find(i) === find(j)) continue // already merged
        if (isBlocked(i, j)) continue
        const score = nameMatch(a.name, b.name)
        if (score >= 0.9 && employerOverlap(a, b)) {
          union(i, j) // near-exact name + shared employer: safe
        } else if (score >= 0.8) {
          // Exact-name-unique pairs with no employer corroboration used to
          // auto-merge here; name equality alone false-merges common names
          // (angel-review C2), so they now surface as candidates instead —
          // flagged exact-name so the review flow can bulk-propose "same".
          const exactUnique =
            score === 1 && nameTokens(a.name).length >= 2 &&
            uniqueInSource(a) && uniqueInSource(b) && !employersConflict(a, b)
          const groupPair = [find(i), find(j)].sort((p, q) => p - q).join('|')
          if (candidateGroupPairs.has(groupPair)) continue
          candidateGroupPairs.add(groupPair)
          candidates.push({
            keys: [a.key, b.key],
            names: [a.name, b.name],
            employers: [a.employer || '', b.employer || ''],
            score: Number(score.toFixed(2)),
            reason: exactUnique ? 'exact-name' : 'fuzzy',
          })
        }
      }
    }
  }

  const groupsByRoot = new Map()
  for (let i = 0; i < records.length; i++) {
    const root = find(i)
    if (!groupsByRoot.has(root)) groupsByRoot.set(root, [])
    groupsByRoot.get(root).push(records[i])
  }

  return { groups: [...groupsByRoot.values()], candidates, warnings }
}

// --- folding -----------------------------------------------------------------

const uniq = (arr) => [...new Set(arr.filter(Boolean))]
const lower = (arr) => uniq(arr.filter(Boolean).map((x) => String(x).toLowerCase().trim()))

const CONFIDENCE_RANK = { high: 4, medium: 3, low: 2, unidentified: 1 }

// Social-graph tie strength (§5.5): a mutual is a stronger tie than a one-way
// follow. Fold the strongest edge present across a merged group; unknown/absent
// edge values are ignored (a strong-identifier merge can carry an edge in from
// one source and a bare record from another).
const EDGE_RANK = { mutual: 3, following: 2, follower: 1 }
const pickEdge = (group) =>
  group
    .map((r) => r.edge)
    // Object.hasOwn, not truthiness: `EDGE_RANK["toString"]` is a live prototype
    // method, so a junk edge like "toString" would both survive and (via the NaN
    // comparator) displace a real "mutual" (angel-review).
    .filter((e) => Object.hasOwn(EDGE_RANK, e))
    .sort((a, b) => EDGE_RANK[b] - EDGE_RANK[a])[0] || null

// Best enrichment wins by confidence, then recency — never by the incidental
// order enrichment batch files happen to load in (angel-review C3).
export function pickEnrichment(keys, enrichments) {
  const cands = keys.map((k) => enrichments[k]).filter(Boolean)
  if (cands.length === 0) return null
  return [...cands].sort(
    (a, b) =>
      (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0) ||
      String(b.enrichedAt || '').localeCompare(String(a.enrichedAt || '')),
  )[0]
}

// For employer/title/bio scalars, professional sources beat social exports and
// newer connections beat older ones — never incidental directory sort order
// (angel-review C3). manual = owner-written quick-adds, the freshest signal.
const FIELD_SOURCE_RANK = { manual: 3, linkedin: 2 }

export function pickRecordField(group, field) {
  const withVal = group.filter((r) => r[field])
  if (withVal.length === 0) return { value: '', alternates: [] }
  const sorted = [...withVal].sort(
    (a, b) =>
      (FIELD_SOURCE_RANK[b.source] || 0) - (FIELD_SOURCE_RANK[a.source] || 0) ||
      String(b.connectedOn || '').localeCompare(String(a.connectedOn || '')),
  )
  const value = sorted[0][field]
  return { value, alternates: uniq(sorted.slice(1).map((r) => r[field])).filter((v) => v !== value) }
}

// Human-ish display name for groups whose sources carry no name at all:
// email localpart, then any handle — never a raw "source:id" key if avoidable.
function fallbackName(group) {
  for (const r of group)
    for (const e of r.emails || [])
      if (typeof e === 'string' && e.includes('@')) return e.split('@')[0]
  for (const r of group)
    for (const h of Object.values(r.handles || {}))
      if (typeof h === 'string' && h.trim()) return h.trim()
  return null
}

export function foldGroup(group, { enrichments = {}, attested = {} } = {}) {
  const keys = group.map((r) => r.key)
  const enrich = pickEnrichment(keys, enrichments)
  const attestList = keys.map((k) => attested[k]).filter(Boolean)
  // User-attested facts rarely conflict; merge them so no attested field is lost.
  const attest = attestList.length ? Object.assign({}, ...attestList) : null

  const names = group.map((r) => r.name).filter(Boolean)
  // Provenance of the winning name (§5.3): a realName from either overlay is a
  // persona→real-identity bridge (hold-back); tag it so a future networked build
  // excludes bridge-derived names mechanically instead of by a remembered rule.
  //
  // Precedence: owner-attested realName outranks a web-research one (the project's
  // stated authority order — "user-attested facts outrank web research"), and an
  // enrichment realName is only adopted at HIGH confidence — a low/medium web
  // guess must not silently become someone's canonical name, all the more so once
  // any BYO adapter (not just Claude) can assert it (angel-review — unmasking gate).
  let nameSource = 'raw'
  let name
  if (attest?.realName) {
    name = attest.realName
    nameSource = 'attested'
  } else if (enrich?.realName && enrich.confidence === 'high') {
    name = enrich.realName
    nameSource = 'enrichment'
  } else {
    name = names.sort((a, b) => b.length - a.length)[0] || fallbackName(group) || keys[0]
  }

  const connectedOn = {}
  for (const r of group) if (r.connectedOn) connectedOn[r.source] = r.connectedOn

  const urls = uniq([...group.flatMap((r) => r.urls || []), enrich?.linkedinUrl])
  const linkedinUrl = enrich?.linkedinUrl || urls.find((u) => typeof u === 'string' && /linkedin\.com\/in\//i.test(u)) || ''

  const employerPick = pickRecordField(group, 'employer')
  const professionPick = pickRecordField(group, 'title')
  const bioPick = pickRecordField(group, 'bio')
  const employer = enrich?.employer || employerPick.value || ''
  // Losing employer values stay visible in notes instead of vanishing.
  const otherEmployers = uniq([employerPick.value, ...employerPick.alternates])
    .filter((v) => v && v !== employer)

  const phones = []
  const seenPhones = new Set()
  for (const r of group) {
    for (const p of r.phones || []) {
      if (typeof p !== 'string' || !p.trim()) continue
      const norm = normPhone(p) || p.trim()
      if (seenPhones.has(norm)) continue
      seenPhones.add(norm)
      phones.push(p.trim())
    }
  }

  const handles = {}
  for (const r of group)
    for (const [platform, h] of Object.entries(r.handles || {}))
      if (typeof h === 'string' && h.trim()) handles[platform] = h.trim()

  return {
    name,
    nameSource,
    keys,
    sources: uniq(group.map((r) => r.source)),
    dids: uniq(group.map((r) => (typeof r.did === 'string' ? r.did.trim().toLowerCase() : null))),
    edge: pickEdge(group),
    emails: uniq(group.flatMap((r) => (r.emails || []).filter((e) => typeof e === 'string' && e.trim()).map(normEmail))),
    phones,
    handles,
    urls,
    linkedinUrl,
    profession: enrich?.profession || professionPick.value || '',
    employer,
    domains: lower([...(enrich?.expertise || []), ...(attest?.domains || [])]),
    roles: lower(group.map((r) => r.title)),
    labels: uniq(group.flatMap((r) => r.labels || [])),
    bio: bioPick.value || '',
    notes: uniq([
      ...group.map((r) => r.notes),
      enrich?.notes,
      otherEmployers.length ? `other/prior employer: ${otherEmployers.join(', ')}` : null,
    ]).join(' / '),
    connectedOn,
    tier: uniq(group.map((r) => r.source)).length > 1 ? 'multi-source' : `${group[0].source}-only`,
    confidence: enrich?.confidence || (attest ? 'attested' : 'none'),
    attested: attest,
    enrichment: enrich
      ? { confidence: enrich.confidence, enrichedAt: enrich.enrichedAt || '', notes: enrich.notes || '' }
      : null,
  }
}

// Ids are unique across the whole build, not just per slug counter — a literal
// "Jane Wilson 2" must not collide with the second "Jane Wilson" (angel-review).
export function assignIds(entries) {
  const used = new Set()
  for (const e of entries) {
    const base = e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'contact'
    let id = base
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`
    used.add(id)
    e.id = id
  }
  return entries
}

// --- full build (shell-friendly wrapper, also the integration-test surface) ---

// sources: [{ source, records: [...], file? }]
export function buildIndex({ sources, decisions = [], enrichments = {}, attested = {} }) {
  const warnings = []
  const records = []
  for (const data of sources) {
    const label = data?.file || data?.source || '(unnamed source)'
    if (!data?.source || !Array.isArray(data.records)) {
      warnings.push(`skipping ${label}: missing "source" or "records" (see docs/schema.md)`)
      continue
    }
    for (const r of data.records) {
      if (!r.sourceId) {
        warnings.push(`skipping record without sourceId in ${label}: ${JSON.stringify(r).slice(0, 80)}`)
        continue
      }
      records.push({ key: `${data.source}:${r.sourceId}`, source: data.source, ...r })
    }
  }
  if (records.length === 0) return { unified: [], candidates: [], warnings, recordCount: 0 }

  const resolved = resolveRecords(records, decisions)
  warnings.push(...resolved.warnings)
  const unified = resolved.groups.map((g) => foldGroup(g, { enrichments, attested }))
  unified.sort((a, b) => a.name.localeCompare(b.name))
  assignIds(unified)
  return { unified, candidates: resolved.candidates, warnings, recordCount: records.length }
}
