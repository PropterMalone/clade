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
// groups (review C1).

import { looksLikeStreetAddress } from './enrich-core.mjs'
import { deriveLocation } from './ingest.mjs'

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

// One tokenizer, two vocabularies. Merge-time employer comparison and fold-time
// export-vs-enrichment comparison ask the same question ("do these two strings
// name the same thing?"), so they must not drift: a second, unfiltered copy of
// this logic let "Ford Motor Company" be overwritten by "Acme Company" on the
// shared token "company" (review 2026-08-04).
export const tokenizeField = (raw, stopwords) => {
  const lower = `${raw || ''}`.toLowerCase()
  const set = new Set(
    lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !stopwords.has(t)),
  )
  if (set.size === 0) {
    // Short names tokenize to nothing ("3M" pre-fix, "AT&T" → at/t, "X"):
    // fall back to the compacted whole name so same-company still overlaps
    // instead of reading as a conflict (review C4).
    const compact = lower.replace(/[^a-z0-9]/g, '')
    if (compact) set.add(compact)
  }
  return set
}

export const employerTokens = (r) => tokenizeField(r.employer, EMPLOYER_STOPWORDS)

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
  // corroboration (review 2026-07-19 Critical). Single-token/blank
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
      // like "null" and false-merge every record carrying them (review C5).
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
  // record (review C1).
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
          // (review C2), so they now surface as candidates instead —
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
    // comparator) displace a real "mutual" (review).
    .filter((e) => Object.hasOwn(EDGE_RANK, e))
    .sort((a, b) => EDGE_RANK[b] - EDGE_RANK[a])[0] || null

// Best enrichment wins by confidence, then recency — never by the incidental
// order enrichment batch files happen to load in (review C3).
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
// (review C3). manual = owner-written quick-adds, the freshest signal.
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

// Job titles collide on hierarchy words the way employers collide on legal
// suffixes — "Marketing Manager" and "Product Manager" are different jobs, and
// "Chief Counsel" is not "Chief Marketing Officer".
const TITLE_STOPWORDS = new Set([
  'the', 'of', 'and', 'for', 'at', 'senior', 'junior', 'chief', 'head', 'lead',
  'principal', 'staff', 'deputy', 'vice', 'president', 'director', 'manager',
  'officer', 'specialist', 'coordinator', 'associate', 'assistant', 'executive',
])

// Localities collide on metro-area phrasing: LinkedIn writes "Greater Chicago
// Area" where an address book writes "Chicago, IL", and those are the same
// place. Only the geography-free glue words are stripped — a qualifier carries
// real signal and must survive into `locationsConflict` below.
const LOCATION_STOPWORDS = new Set([
  'the', 'of', 'and', 'greater', 'area', 'metro', 'metropolitan', 'region', 'county', 'city',
])

// A locality is `City[, Qualifier]`, and the flat token-overlap test below is
// WRONG for that shape: it calls two values corroborating on ANY shared token,
// so "Portland, OR" agrees with "Portland, ME" (shared city) and "Evanston, IL"
// agrees with "Chicago, IL" (shared state). Both let a low-confidence web guess
// silently overwrite the city the owner's own address book supplied — the exact
// ADR-09 failure this precedence machinery exists to prevent, found by review
// 2026-08-06 with the earlier keep-qualifiers-out-of-the-stopword-list fix in
// place, which was necessary and nowhere near sufficient.
//
// So locations get their own agreement test: split on the LAST comma into head
// (the locality) and qualifier (region or country); the heads must overlap, and
// when BOTH sides carry a qualifier the qualifiers must overlap too.
// "Greater Chicago Area" (no qualifier) still corroborates "Chicago, IL".
//
// Fails CLOSED on qualifier spelling: "Wichita, KS" vs "Wichita, Kansas" reads as a
// conflict, keeping the first-party value and filing the web one for audit. That
// costs one refresh; the opposite error overwrites a correct address-book city
// with a same-named stranger's, unrecoverably and with no audit trail.
const splitLocality = (v) => {
  const s = String(v || '').trim()
  const i = s.lastIndexOf(',')
  return i === -1 ? { head: s, qualifier: '' } : { head: s.slice(0, i), qualifier: s.slice(i + 1) }
}

export const locationsConflict = (a, b) => {
  const la = splitLocality(a)
  const lb = splitLocality(b)
  if (valuesConflict(la.head, lb.head, LOCATION_STOPWORDS)) return true
  if (!la.qualifier.trim() || !lb.qualifier.trim()) return false // one side unqualified: heads agreeing is enough
  return valuesConflict(la.qualifier, lb.qualifier, LOCATION_STOPWORDS)
}

// Two values CONFLICT when they share no identity-bearing token. Fails CLOSED:
// a value that tokenizes to nothing (a CJK employer under an ASCII tokenizer)
// counts as a conflict, so first-party data is kept rather than overwritten by
// a web guess we cannot compare against.
const valuesConflict = (a, b, stopwords) => {
  const ta = tokenizeField(a, stopwords)
  const tb = tokenizeField(b, stopwords)
  if (!ta.size || !tb.size) return true
  for (const t of ta) if (tb.has(t)) return false
  return true
}

// Which value wins for a field the owner's export AND web research both supply.
//
// The rule, precisely: web research wins when the export field is empty, when
// research is HIGH confidence, or when the web value agrees with ANY first-party
// value in the group (agreement is evidence it really is the same person, so a
// low/medium reading that matches the owner's own other export is a corroborated
// refresh, not a guess). Otherwise the export value stands and the web value is
// returned as `rejected` for the caller to record separately.
//
// Why: enrichment silently overwriting the owner's own export is editing their
// record, which ADR-09 forbids — the field case (2026-08-04) was a LinkedIn URL
// in the export resolving to a same-named stranger, whose "Microsoft" replaced
// the correct employer that was on file the whole time. An export still
// freezes the employer at connection date, so confident research must be able to
// refresh a stale value; only an UNcorroborated disagreement is refused.
// `conflicts` lets a field supply its own agreement test — locality strings are
// structured (`City, Qualifier`) and the flat token-overlap default calls
// "Portland, OR" and "Portland, ME" the same place. Defaults to the flat test so
// employer and profession are unchanged.
function preferExportOnConflict({ web, own, alternates = [], confidence, stopwords, conflicts }) {
  const disagree = conflicts || ((a, b) => valuesConflict(a, b, stopwords))
  const webValue = String(web || '').trim()
  const ownValue = String(own || '').trim()
  if (!webValue) return { value: ownValue, rejected: '' }
  if (!ownValue) return { value: webValue, rejected: '' }
  if (confidence === 'high') return { value: webValue, rejected: '' }
  const firstParty = [ownValue, ...alternates.map((a) => String(a || '').trim())].filter(Boolean)
  const corroborated = firstParty.some((v) => !disagree(webValue, v))
  return corroborated ? { value: webValue, rejected: '' } : { value: ownValue, rejected: webValue }
}

// Street addresses union across a merged person, deduped on the GEOGRAPHIC
// components — the same home arriving from a vCard and from Google Contacts is
// one address, even when one export labels it "home" and the other says nothing.
// `formatted` is excluded from the dedupe KEY (two copies differing only in a
// source-supplied one-line form are the same place) but counts for EMPTINESS:
// Google's People API allows a formattedValue with no structured components, and
// reusing the dedupe key as the empty test silently deleted those addresses
// between the normalized file and the index.
const ADDRESS_DEDUPE_FIELDS = ['pobox', 'extended', 'street', 'city', 'region', 'postal', 'country']
const ADDRESS_CONTENT_FIELDS = ['formatted', ...ADDRESS_DEDUPE_FIELDS]

export function addressUnion(group) {
  const addresses = []
  const seen = new Set()
  for (const r of group) {
    for (const a of Array.isArray(r.addresses) ? r.addresses : []) {
      if (!a || typeof a !== 'object' || Array.isArray(a)) continue
      if (!ADDRESS_CONTENT_FIELDS.some((f) => String(a[f] ?? '').trim())) continue // type-only: no place in it
      const geo = ADDRESS_DEDUPE_FIELDS.map((f) => String(a[f] ?? '').trim().toLowerCase()).join('|')
      // A formatted-only address has no structured components, so the geographic
      // key collapses to empty and it would skip dedup entirely — two copies of
      // the same one from two sources both landed. Fall back to `formatted`.
      const norm = geo.replace(/\|/g, '') ? geo : String(a.formatted ?? '').trim().toLowerCase()
      if (norm && seen.has(norm)) continue
      if (norm) seen.add(norm)
      addresses.push(a)
    }
  }
  return addresses
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
  // any BYO adapter (not just Claude) can assert it (review — unmasking gate).
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
  const employerChoice = preferExportOnConflict({
    web: enrich?.employer,
    own: employerPick.value,
    alternates: employerPick.alternates,
    confidence: enrich?.confidence,
    stopwords: EMPLOYER_STOPWORDS,
  })
  const professionChoice = preferExportOnConflict({
    web: enrich?.profession,
    own: professionPick.value,
    alternates: professionPick.alternates,
    confidence: enrich?.confidence,
    stopwords: TITLE_STOPWORDS,
  })
  const employer = employerChoice.value

  // Location folds on the same rule as employer/profession (ADR-09): the owner's
  // own export outranks an uncorroborated web guess. People move, so confident
  // research must still be able to refresh a locality frozen at connection date.
  // Two deliberate departures from the employer rule, both from review 2026-08-06:
  // the agreement test is locality-aware (`locationsConflict`), and an empty
  // first-party value does NOT hand the field to any-confidence research.
  const locationPick = pickRecordField(group, 'location')
  // `deriveLocation`'s home-beats-work rule only holds WITHIN one record;
  // `pickRecordField` ranks the address-book sources equally and tie-breaks on an
  // empty connectedOn, so argument order decided which city a merged person got.
  // Re-deriving across the merged address union makes the rule global. A `manual`
  // quick-add still wins — the owner typed it today, and FIELD_SOURCE_RANK
  // already says so; this only settles the address-book tie.
  const manualLocation = group.find((r) => r.source === 'manual' && r.location)?.location || ''
  const firstPartyLocation = manualLocation || deriveLocation(addressUnion(group)) || locationPick.value
  const webLocation = String(enrich?.location || '').trim()
  const locationChoice = preferExportOnConflict({
    web: enrich?.location,
    own: firstPartyLocation,
    alternates: locationPick.alternates,
    confidence: enrich?.confidence,
    stopwords: LOCATION_STOPWORDS,
    conflicts: locationsConflict,
  })
  let location = locationChoice.value
  let rejectedLocation = locationChoice.rejected
  // NEW-SOURCE ENROLLMENT POINT. `first-party` means "came from the owner's own
  // records" — an address book, a quick-add, any export — NOT "there is a street
  // address behind it". Origin comes from HOW the value won, never from what it
  // equals: a web value that merely MATCHES an owner-custody value is a
  // coincidence of string, usually the model echoing the labelled location line
  // the solo prompt handed it. ADR-08 classifies by custody, so labelling that
  // `enrichment` would clear it for a shared confirm batch — the exact disclosure
  // this field exists to stop. Fails CLOSED: anything not provably public-web is
  // owner-custody. Consequence when adding a source: a genuinely SELF-PUBLISHED
  // public location (an X/Twitter profile `location`) lands in `first-party` by
  // default and is silently barred from the confirm tier. Register it here.
  const webWonOnItsOwnEvidence =
    Boolean(webLocation) &&
    location === webLocation &&
    (!firstPartyLocation || locationsConflict(webLocation, firstPartyLocation))
  let locationSource = location ? (webWonOnItsOwnEvidence ? 'enrichment' : 'first-party') : ''
  // An empty first-party location is the DOMINANT case, not the edge case:
  // LinkedIn, Facebook and Bluesky all emit `location: ''` by construction, so
  // most of a real corpus takes the empty branch. `preferExportOnConflict` hands
  // an empty field to research at ANY confidence — right for employer (usually
  // first-party-populated), wrong here, where it would fill the index with
  // unvetted guesses. Thin contacts are also the ones that receive the owner's
  // life-history prior, and the prompt bars the prior from a search QUERY but not
  // from the ANSWER — so a low-confidence miss can mirror the owner's own era
  // cities back onto named strangers. Require medium+ to claim an empty field.
  if (!firstPartyLocation && webLocation && !['high', 'medium'].includes(enrich?.confidence)) {
    location = ''
    locationSource = ''
    rejectedLocation = webLocation
  }
  // The owner outranks both their stale export and the web — they know where
  // their own friend lives. A web claim displaced this way was still refused, so
  // it goes to the audit trail instead of vanishing. Assign UNCONDITIONALLY: a
  // stale `rejected` computed against the export used to survive an attestation
  // that agreed with the web value, so the record claimed to have refused a claim
  // it was simultaneously reporting as authoritative.
  const attestedLocation = String(attest?.location || '').trim()
  if (attestedLocation) {
    rejectedLocation = webLocation && locationsConflict(webLocation, attestedLocation) ? webLocation : ''
    location = attestedLocation
    locationSource = 'attested'
  }
  // Defense in depth, and the reason it is HERE: the index is where the
  // shareable grade is actually constituted, while the three write-time guards
  // (validateEnrichment, attest.mjs, deriveLocation) each cover one producer.
  // A value banked before a guard existed — or by a producer added later —
  // would otherwise flow straight to the export, the seam, and the prompts. The
  // build is regenerable, so failing closed here costs nothing permanent.
  // (foldGroup is pure and has no warnings channel; the drop is silent by
  // design — every producer already refuses these at write time and reports it
  // there, so reaching this line means legacy or out-of-band data.)
  if (looksLikeStreetAddress(location)) {
    location = ''
    locationSource = ''
  }

  // Street addresses union across the merged person, deduped on the geographic
  // components — the same home arriving from both a vCard and Google Contacts is
  // one address, even when one export labels it "home" and the other says
  // nothing. HOLD-BACK (ADR-10): this array is for the owner's own use and is
  // stripped from every egress path; `location` above is the shareable grade.
  const addresses = addressUnion(group)

  // A refused LOCATION must not blank the enrichment narrative out of `notes`:
  // that narrative argues for a refused EMPLOYER or TITLE, which is why the
  // suppression exists, and says nothing about a correctly-resolved job. Gating
  // it on the location too cost search recall on contacts whose enrichment was
  // fine (review 2026-08-06). `unconfirmed` still records every refusal.
  const rejectedAnyClaim = Boolean(employerChoice.rejected || professionChoice.rejected || rejectedLocation)
  const rejectedNarrativeClaim = Boolean(employerChoice.rejected || professionChoice.rejected)
  // Losing FIRST-PARTY employer values stay visible in notes instead of
  // vanishing. A rejected web claim deliberately does NOT go here: `notes` feeds
  // both search.mjs's match haystack and the exported Project knowledge file, so
  // filing a wrong-person guess as "other/prior employer" would keep surfacing
  // this contact for that employer — the exact symptom the rule exists to stop.
  // Rejected claims go to `unconfirmed`, which nothing indexes. Compare trimmed:
  // the winner is trimmed, so an untrimmed source value would else list itself.
  const otherEmployers = uniq([employerPick.value, ...employerPick.alternates])
    .map((v) => String(v || '').trim())
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
    profession: professionChoice.value,
    employer,
    location,
    // Origin of the winning `location`, mirroring `nameSource`. Load-bearing for
    // egress, not decoration: ADR-08 says owner-attested facts may not share a
    // batched enrichment session, and a location derived from a private
    // address-book street entry is not public-web either. `contactBlock` reads
    // this to decide whether the value may enter a shared confirm block.
    locationSource,
    addresses,
    // Web claims this fold refused, kept for audit but deliberately NOT indexed
    // by search or exported to the Project file — they may describe a different
    // person entirely, which is why they lost. The enrichment's own narrative
    // comes along when anything was rejected: it argues FOR the rejected claim
    // ("a same-named engineer at some consultancy…"), so
    // leaving it in `notes` would keep the contact searchable by the very
    // employer this fold refused.
    unconfirmed: rejectedAnyClaim
      ? {
          ...(employerChoice.rejected ? { employer: employerChoice.rejected } : {}),
          ...(professionChoice.rejected ? { profession: professionChoice.rejected } : {}),
          ...(rejectedLocation ? { location: rejectedLocation } : {}),
          ...(enrich?.notes ? { notes: enrich.notes } : {}),
        }
      : null,
    domains: lower([...(enrich?.expertise || []), ...(attest?.domains || [])]),
    roles: lower(group.map((r) => r.title)),
    labels: uniq(group.flatMap((r) => r.labels || [])),
    bio: bioPick.value || '',
    notes: uniq([
      ...group.map((r) => r.notes),
      rejectedNarrativeClaim ? null : enrich?.notes,
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
// "Jane Wilson 2" must not collide with the second "Jane Wilson" (review).
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
