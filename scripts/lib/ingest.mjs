// pattern: functional-core
// Source-export parsing for ingestion. Pure functions — no fs, no clock.
// Shell: scripts/convert-linkedin.mjs.
//
// Exists because ad-hoc converters kept mis-parsing real exports: LinkedIn's
// Connections.csv quotes fields containing commas ("Acme, Inc.", last names
// like "Barlow, CPA"), and a bare split(',') shifts every later column —
// employer becomes "Inc.", the URL lands in the wrong field, and the derived
// sourceId turns into junk like "cpa". Parse CSV properly, once.

// RFC-4180-ish CSV: quoted fields, "" escapes, CRLF, embedded newlines.
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// Post-nominal credentials LinkedIn users append to their last name
// ("Barlow, CPA" / "Molnar, MD, CFE" / "Boyan, Ph.D."). Stripped from the
// display name (so exact-name matching against other sources works) and kept
// as labels. A comma-segment counts as a credential if it's a known
// abbreviation, a dotted abbreviation (M.A., Ph.D., M.Acc.), or short
// all-caps (CPA/ABV/CFF, OTR/L, ENV SP, PI) — real name fragments after a
// comma ("Windsor, Duke of Kent") contain lowercase words and are kept.
const KNOWN_CREDENTIALS = new Set([
  'cpa', 'cfa', 'cfe', 'cfp', 'cia', 'cissp', 'cism', 'cisa', 'pmp', 'esq',
  'jd', 'md', 'do', 'phd', 'edd', 'mba', 'mpa', 'mph', 'msw', 'rn', 'pe',
  'cae', 'sphr', 'phr', 'aicp', 'frm', 'caia', 'cma', 'cgma', 'crc', 'chfc',
  'clu', 'cpcu', 'llm', 'dvm', 'lcsw', 'lpc', 'aca', 'cphq', 'mps', 'ma',
  'ms', 'macc', 'cva', 'cams', 'otrl', 'leedap', 'shrmcp', 'shrmscp',
])
const GENERATIONAL = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'vi'])
const isCredentialSegment = (seg) => {
  const canon = seg.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (GENERATIONAL.has(canon)) return false // "Smith, III" is a name suffix, not a credential
  if (KNOWN_CREDENTIALS.has(canon) || /^series\d+$/.test(canon)) return true
  if (/^[A-Za-z]{1,2}(\.[A-Za-z]{1,4})+\.?$/.test(seg)) return true // dotted: Ph.D., M.Acc.
  if (/^[A-Z0-9/.\-® ]{2,14}$/.test(seg)) return true // all-caps: CPA/ABV/CFF, CTAL-TM
  return false
}

export function splitCredentials(lastNameField) {
  const parts = String(lastNameField || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length < 2) return { lastName: parts[0] || '', credentials: [] }
  const credentials = []
  while (parts.length > 1 && isCredentialSegment(parts[parts.length - 1])) {
    credentials.unshift(parts.pop().replace(/[.®]+$/, ''))
  }
  return { lastName: parts.join(', '), credentials }
}

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const linkedinSlug = (url) => {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url || '')
  return m ? decodeURIComponent(m[1]).toLowerCase() : null
}

// "25 May 2023" -> "2023-05-25" (LinkedIn's Connected On format); '' if unparseable.
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' }
export function parseConnectedOn(s) {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})$/.exec(String(s || '').trim())
  if (!m) return ''
  const mm = MONTHS[m[2].toLowerCase()]
  return mm ? `${m[3]}-${mm}-${String(m[1]).padStart(2, '0')}` : ''
}

// Connections.csv text -> { records, warnings }. Rows without a name are
// skipped with a warning rather than silently dropped.
export function linkedinRecords(csvText) {
  const rows = parseCsv(csvText)
  // LinkedIn prepends a free-text notes preamble; the real header starts at "First Name".
  const headerIdx = rows.findIndex((r) => r[0]?.trim() === 'First Name')
  if (headerIdx === -1) return { records: [], warnings: ['no "First Name" header row found — is this a LinkedIn Connections.csv?'] }
  const headers = rows[headerIdx].map((h) => h.trim())
  const col = (row, name) => (row[headers.indexOf(name)] || '').trim()

  const records = []
  const warnings = []
  const usedIds = new Set()
  for (const row of rows.slice(headerIdx + 1)) {
    if (row.every((c) => !c.trim())) continue
    const first = col(row, 'First Name')
    const { lastName, credentials } = splitCredentials(col(row, 'Last Name'))
    const name = `${first} ${lastName}`.trim()
    if (!name) {
      warnings.push(`skipping row with no name: ${JSON.stringify(row.join(',')).slice(0, 80)}`)
      continue
    }
    const url = col(row, 'URL')
    let sourceId = linkedinSlug(url) || slugify(name) || 'contact'
    while (usedIds.has(sourceId)) sourceId = `${sourceId}-x` // duplicate slugs are rare; keep ids unique
    usedIds.add(sourceId)
    const email = col(row, 'Email Address')
    records.push({
      sourceId,
      name,
      emails: email ? [email] : [],
      phones: [],
      employer: col(row, 'Company'),
      title: col(row, 'Position'),
      urls: url ? [url] : [],
      handles: {},
      bio: '',
      labels: credentials,
      connectedOn: parseConnectedOn(col(row, 'Connected On')),
      notes: '',
    })
  }
  return { records, warnings }
}

// --- Facebook friends export -------------------------------------------------
// Meta ships either JSON ({"friends_v2":[{name, timestamp}]}) or HTML
// (your_friends.html: <section><h2>Name</h2>...<div class="_a72d">date</div>).
// Both carry name + friend-date only — thin by design; the life-history prior
// and owner triage carry this source (see CLAUDE.md steps 0 and 4).

const decodeEntities = (s) =>
  String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))

// "Oct 19, 2025 1:47:55 pm" -> "2025-10-19"
export function parseFbDate(s) {
  const m = /^([A-Za-z]{3})\w*\s+(\d{1,2}),\s+(\d{4})/.exec(String(s || '').trim())
  if (!m) return ''
  const mm = MONTHS[m[1].toLowerCase()]
  return mm ? `${m[3]}-${mm}-${String(m[2]).padStart(2, '0')}` : ''
}

const fbRecord = (name, connectedOn, usedIds) => {
  let sourceId = slugify(name) || 'friend'
  while (usedIds.has(sourceId)) sourceId = `${sourceId}-x` // two same-name friends are two people
  usedIds.add(sourceId)
  return {
    sourceId,
    name,
    emails: [],
    phones: [],
    employer: '',
    title: '',
    urls: [],
    handles: {},
    bio: '',
    labels: [],
    connectedOn,
    notes: '',
  }
}

// Accepts either export format; sniffs JSON vs HTML from content.
export function facebookFriendsRecords(text) {
  const warnings = []
  const records = []
  const usedIds = new Set()
  const trimmed = String(text).trim()

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let data
    try {
      data = JSON.parse(trimmed)
    } catch {
      return { records: [], warnings: ['file looks like JSON but does not parse'] }
    }
    const list = data.friends_v2 || data.friends || (Array.isArray(data) ? data : [])
    for (const f of list) {
      const name = decodeEntities(f.name || '').trim()
      if (!name) continue
      const connectedOn = f.timestamp
        ? new Date(f.timestamp * 1000).toISOString().slice(0, 10)
        : ''
      records.push(fbRecord(name, connectedOn, usedIds))
      records[records.length - 1].connectedOn = connectedOn
    }
    if (records.length === 0) warnings.push('no friends found in JSON — expected friends_v2 array')
    return { records, warnings }
  }

  // HTML: split per <section> first so a friend missing a date div can't
  // steal the NEXT friend's date (lazy [\s\S]*? crossed section boundaries —
  // angel-review 2026-07-19: misattributed dates + silently dropped friends).
  for (const section of trimmed.split(/<section\b/).slice(1)) {
    const nm = /<h2[^>]*>([^<]+)<\/h2>/.exec(section)
    if (!nm) continue
    const name = decodeEntities(nm[1]).trim()
    if (!name) continue
    const dm = /<div class="_a72d">([^<]*)<\/div>/.exec(section)
    if (!dm) warnings.push(`no friend-date found for ${name} — connectedOn left empty`)
    records.push(fbRecord(name, dm ? parseFbDate(dm[1]) : '', usedIds))
  }
  if (records.length === 0) warnings.push('no <h2>/date pairs found — is this your_friends.html?')
  return { records, warnings }
}

// --- Google Contacts CSV export ----------------------------------------------
// takeout.google.com Contacts CSV. Multi-valued cells use " ::: " separators;
// the Labels column carries group memberships ("* myContacts ::: * friends :::
// Kickball League") — real interest signal once the "* " system groups are
// stripped. An earlier ad-hoc converter leaked labels and photo URLs into the
// email field, where two records sharing "* myContacts" as an "email" glued
// unrelated people; hence this committed parser + email validation.

const splitMulti = (v) => String(v || '').split(' ::: ').map((s) => s.trim()).filter(Boolean)
const looksLikeEmail = (e) => e.includes('@') && !e.includes(' ')

export function googleContactsRecords(csvText) {
  const rows = parseCsv(csvText)
  if (rows.length < 2) return { records: [], warnings: ['empty file'] }
  const headers = rows[0].map((h) => h.trim())
  if (!headers.includes('First Name')) {
    return { records: [], warnings: ['no "First Name" column — is this a Google Contacts CSV export?'] }
  }
  const col = (row, name) => {
    const i = headers.indexOf(name)
    return i === -1 ? '' : (row[i] || '').trim()
  }

  const records = []
  const warnings = []
  const usedIds = new Set()
  for (const row of rows.slice(1)) {
    if (row.every((c) => !c.trim())) continue
    const name = [col(row, 'First Name'), col(row, 'Middle Name'), col(row, 'Last Name')]
      .filter(Boolean).join(' ').trim() || col(row, 'File As')

    const emails = []
    for (let n = 1; n <= 3; n++) {
      for (const e of splitMulti(col(row, `E-mail ${n} - Value`))) {
        if (looksLikeEmail(e)) {
          emails.push(e)
          continue
        }
        // "Frost, Wanda (ACME) <wanda.frost@example.org>" — RFC-822 form
        const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(e)
        if (angled) emails.push(angled[1])
        else warnings.push(`${name || '(unnamed)'}: dropping non-email value in E-mail ${n}: ${JSON.stringify(e).slice(0, 60)}`)
      }
    }
    const phones = []
    for (let n = 1; n <= 4; n++) phones.push(...splitMulti(col(row, `Phone ${n} - Value`)))

    if (!name && emails.length === 0) {
      warnings.push(`skipping row with no name and no email: ${JSON.stringify(row.join(',')).slice(0, 60)}`)
      continue
    }
    const displayName = name || emails[0].split('@')[0]
    let sourceId = slugify(displayName) || 'contact'
    for (let n = 2; usedIds.has(sourceId); n++) sourceId = `${slugify(displayName)}-${n}` // legacy numeric suffixes: keeps ruling keys stable
    usedIds.add(sourceId)

    const labels = splitMulti(col(row, 'Labels'))
      .map((l) => l.replace(/^\* /, ''))
      .filter((l) => !['myContacts', 'starred'].includes(l)) // system groups carry no signal

    records.push({
      sourceId,
      name: displayName,
      emails: [...new Set(emails)],
      phones: [...new Set(phones)],
      employer: col(row, 'Organization Name'),
      title: col(row, 'Organization Title'),
      urls: splitMulti(col(row, 'Website 1 - Value')),
      handles: {},
      bio: '',
      labels,
      connectedOn: '',
      notes: col(row, 'Notes'),
    })
  }
  return { records, warnings }
}

// --- vCard (.vcf) export ------------------------------------------------------
// Apple Contacts.app / iCloud, Google, and Outlook all export vCard. A .vcf is
// one or more BEGIN:VCARD…END:VCARD cards. Real-world quirks a naive line-split
// mangles: RFC-6350 line FOLDING (a long value — a NOTE, or a base64 PHOTO blob
// — wraps onto continuation lines that begin with one space/tab; unfold before
// anything else or a folded value bleeds into the next property), Apple's
// `itemN.PROP` prefixes (the prefix is stripped so `item1.EMAIL` parses as
// EMAIL; the paired `item1.X-ABLabel` custom label is NOT yet consumed — see
// the follow-up note on `group` in parseVcardLine), backslash escaping inside
// values (\, \; \n \\), and `;`-delimited structured N/ORG components. Parse the
// container properly, once.

// Unfold continuation lines and normalize CRLF/CR to LF. A newline followed by
// a single space or tab is a fold marker, not a value boundary — drop both.
// BOM is stripped globally (not just leading): the shell concatenates several
// .vcf files, so a BOM at the start of the 2nd+ file lands mid-stream, where it
// would break the `^BEGIN:VCARD` line match and silently swallow that card.
// the `\uFEFF` escape (not a literal BOM) so a formatter can't strip it invisibly.
const unfoldVcard = (text) => String(text).replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '')

// Reverse vCard text escaping (\n/\N → newline, \, \; \\ → the literal char).
const unescapeVcard = (v) =>
  String(v).replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c))

// Split on unescaped `sep` (for structured N/ORG). Escape sequences are left
// intact in the pieces so the caller can unescape each one.
const splitVcardStructured = (value, sep) => {
  const out = []
  let cur = ''
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\') {
      cur += value[i] + (value[i + 1] ?? '')
      i++
    } else if (value[i] === sep) {
      out.push(cur)
      cur = ''
    } else cur += value[i]
  }
  out.push(cur)
  return out
}

// Parse one content line into { prop, group, params, value }. Property and
// param names are case-insensitive (uppercased); a `itemN.` group prefix is
// split off. TYPE params (comma- or repeated-`;`-separated, quoted or bare —
// vCard 2.1 writes bare `TEL;CELL:`) collect into params.type[].
const parseVcardLine = (line) => {
  const colon = line.indexOf(':')
  if (colon === -1) return null
  const segs = line.slice(0, colon).split(';')
  let prop = segs[0]
  let group = null
  const dot = prop.indexOf('.')
  if (dot !== -1) {
    group = prop.slice(0, dot).toLowerCase()
    prop = prop.slice(dot + 1)
  }
  const params = {}
  for (const p of segs.slice(1)) {
    const eq = p.indexOf('=')
    if (eq === -1) (params.type ||= []).push(p.toLowerCase())
    else {
      const k = p.slice(0, eq).toLowerCase()
      const raw = p.slice(eq + 1)
      if (k === 'type') (params.type ||= []).push(...raw.split(',').map((x) => x.toLowerCase().replace(/^"|"$/g, '')))
      else params[k] = raw.replace(/^"|"$/g, '')
    }
  }
  // `group` (the itemN. prefix) is retained but not yet consumed — wiring it to
  // pair `itemN.X-ABLabel` custom labels onto the grouped property is a follow-up.
  return { prop: prop.toUpperCase(), group, params, value: line.slice(colon + 1) }
}

// Fold an X-SOCIALPROFILE / IMPP line into the card. Service is the non-generic
// TYPE (twitter/facebook/…) or X-SERVICE-TYPE; the handle is X-USER, else the
// value with a profile URL reduced to its last path segment, or a bare
// `scheme:` URI (skype:user, xmpp:user@host) stripped of its scheme. An http(s)
// value is ALSO pushed into urls[] so the resolver's URL-derived merge keys
// (linkedin: etc.) still fire — it keys those off urls[], not handles.
//
// Degenerate URL segments are REJECTED rather than emitted as a handle:
// `facebook.com/profile.php?id=123` reduces to a shared "profile.php" that the
// resolver would treat as an authoritative merge key and use to glue every
// contact carrying that URL form into one person. Prefer the identifying `id=`
// query param; refuse any segment that still looks non-identifying (contains a
// dot, e.g. `profile.php`) or an empty segment (a bare host).
const GENERIC_TYPE = new Set(['pref', 'home', 'work', 'other', 'internet', 'voice', 'cell', 'main'])
const addVcardHandle = (c, p) => {
  const service = (p.params['x-service-type'] || (p.params.type || []).find((t) => !GENERIC_TYPE.has(t)) || '').toLowerCase()
  const rawVal = unescapeVcard(p.value).trim()
  if (/^https?:\/\//i.test(rawVal) && !c.urls.includes(rawVal)) c.urls.push(rawVal)
  if (!service) return
  const xuser = (p.params['x-user'] || '').trim()
  let handle
  if (xuser) {
    handle = xuser
  } else if (/^https?:\/\//i.test(rawVal)) {
    const m = /^https?:\/\/[^/]+\/(?:.*\/)?([^/?#]*)(?:\?([^#]*))?/i.exec(rawVal)
    const idParam = m && m[2] && /(?:^|&)id=([^&]+)/i.exec(m[2])
    let seg = idParam ? idParam[1] : m ? m[1] : ''
    try {
      seg = decodeURIComponent(seg)
    } catch {
      /* malformed %-escape — keep the raw segment rather than throwing */
    }
    if (!seg || seg.includes('.')) return // non-identifying: bare host, or "profile.php"-style
    handle = seg
  } else {
    handle = rawVal.replace(/^[a-z][a-z0-9+.-]*:/i, '') // bare-scheme URI → drop the scheme
  }
  handle = handle.replace(/^@/, '').trim().toLowerCase()
  if (handle && !c.handles[service]) c.handles[service] = handle
}

// Extract the fields we keep from one card's content lines. PHOTO, ADR, BDAY,
// VERSION, PRODID, X-ABUID and friends are intentionally dropped — a rolodex
// doesn't need them, and PHOTO in particular is a multi-KB base64 blob.
function parseVcard(lines) {
  const c = { fn: '', n: null, emails: [], phones: [], urls: [], org: '', title: '', notes: '', uid: '', handles: {}, labels: [] }
  let qpSeen = false
  for (const line of lines) {
    const p = parseVcardLine(line)
    if (!p) continue
    // vCard 2.1 writes quoted-printable either as ENCODING=QUOTED-PRINTABLE or
    // the bare-param shorthand `FN;QUOTED-PRINTABLE:` (→ params.type). Detect both.
    if (/quoted-printable/i.test(p.params.encoding || '') || (p.params.type || []).includes('quoted-printable')) qpSeen = true
    switch (p.prop) {
      case 'FN': c.fn = unescapeVcard(p.value).trim(); break
      case 'N': c.n = splitVcardStructured(p.value, ';').map((s) => unescapeVcard(s).trim()); break
      // Strip a `mailto:`/`tel:` URI scheme — otherwise it corrupts the value AND
      // the resolver's merge key (email:mailto:x@y never matches email:x@y).
      case 'EMAIL': { const e = unescapeVcard(p.value).trim().replace(/^mailto:/i, ''); if (e) c.emails.push(e); break }
      case 'TEL': { const t = unescapeVcard(p.value).trim().replace(/^tel:/i, ''); if (t) c.phones.push(t); break }
      case 'URL':
      case 'X-URL': { const u = p.value.trim(); if (u) c.urls.push(u); break } // URI-typed: not backslash-escaped per RFC 6350
      case 'ORG': if (!c.org) c.org = splitVcardStructured(p.value, ';').map((s) => unescapeVcard(s).trim()).find(Boolean) || ''; break
      case 'TITLE': if (!c.title) c.title = unescapeVcard(p.value).trim(); break
      case 'NOTE': if (!c.notes) c.notes = unescapeVcard(p.value).trim(); break
      case 'UID': if (!c.uid) c.uid = p.value.trim().replace(/^urn:uuid:/i, ''); break
      // Drop Google's signal-free system groups (myContacts/starred), same as the CSV path.
      case 'CATEGORIES': c.labels.push(...splitVcardStructured(p.value, ',').map((s) => unescapeVcard(s).trim()).filter((l) => l && !['myContacts', 'starred'].includes(l))); break
      case 'X-SOCIALPROFILE':
      case 'IMPP': addVcardHandle(c, p); break
    }
  }
  return { card: c, qpSeen }
}

// A whole .vcf (possibly many concatenated exports) -> { records, warnings }.
// sourceId prefers the card's own UID (stable across re-exports even if the
// name changes — the vCard analog of LinkedIn's URL slug), falling back to the
// name slug with a numeric disambiguator.
export function vcardRecords(text) {
  const unfolded = unfoldVcard(text)
  if (!/BEGIN:VCARD/i.test(unfolded)) {
    return { records: [], warnings: ['no BEGIN:VCARD found — is this a .vcf export?'] }
  }
  const warnings = []
  // Flat BEGIN/END scan. A BEGIN arriving before the previous card's END means
  // either a truncated card (missing END) or an embedded 2.1 AGENT card; salvage
  // what accumulated and warn rather than silently dropping the outer card.
  const blocks = []
  let cur = null
  for (const line of unfolded.split('\n')) {
    if (/^BEGIN:VCARD\s*$/i.test(line)) {
      if (cur && cur.length) {
        warnings.push('BEGIN:VCARD before END:VCARD — an embedded/AGENT card or a missing END:VCARD; parsing the cards separately')
        blocks.push(cur)
      }
      cur = []
    } else if (/^END:VCARD\s*$/i.test(line)) {
      if (cur) blocks.push(cur)
      cur = null
    } else if (cur) cur.push(line)
  }
  if (cur && cur.length) {
    warnings.push('file ended mid-card (no END:VCARD) — the last card may be incomplete')
    blocks.push(cur)
  }

  const records = []
  const usedIds = new Set()
  const seenUids = new Set()
  let qpWarned = false
  for (const lines of blocks) {
    let parsed
    try {
      parsed = parseVcard(lines)
    } catch (err) {
      warnings.push(`skipping a card that failed to parse: ${err.message}`)
      continue
    }
    const { card, qpSeen } = parsed
    if (qpSeen && !qpWarned) {
      warnings.push('quoted-printable values seen (vCard 2.1) — not decoded; re-export as vCard 3.0/4.0 if fields look garbled')
      qpWarned = true
    }
    // Same UID = the same card imported twice (the natural case when several
    // overlapping exports are concatenated). Keep the first; a suffixed second
    // record would split one person and orphan overlays on the losing key.
    if (card.uid) {
      if (seenUids.has(card.uid)) {
        warnings.push(`duplicate UID ${card.uid} — same card appears twice in the input; keeping the first`)
        continue
      }
      seenUids.add(card.uid)
    }
    const assembledN = card.n ? [card.n[1], card.n[2], card.n[0]].filter(Boolean).join(' ').trim() : ''
    const name = card.fn || assembledN
    const emails = []
    for (const e of card.emails) {
      if (looksLikeEmail(e)) emails.push(e)
      else warnings.push(`${name || '(unnamed)'}: dropping non-email EMAIL value ${JSON.stringify(e).slice(0, 60)}`)
    }
    if (!name && emails.length === 0) {
      const hint = card.uid ? ` (UID ${card.uid})` : card.phones[0] ? ` (phone ${card.phones[0]})` : card.org ? ` (org ${card.org})` : ''
      warnings.push(`skipping card with no name and no email${hint}`)
      continue
    }
    const displayName = name || emails[0].split('@')[0]
    const idBase = slugify(card.uid) || slugify(displayName) || 'contact'
    let sourceId = idBase
    for (let n = 2; usedIds.has(sourceId); n++) sourceId = `${idBase}-${n}`
    usedIds.add(sourceId)
    records.push({
      sourceId,
      name: displayName,
      emails: [...new Set(emails)],
      phones: [...new Set(card.phones)],
      employer: card.org,
      title: card.title,
      urls: [...new Set(card.urls)],
      handles: card.handles,
      bio: '',
      labels: [...new Set(card.labels)],
      connectedOn: '',
      notes: card.notes,
    })
  }
  return { records, warnings }
}

// --- Bluesky (atproto) graph -------------------------------------------------
// Unlike the file-export sources, Bluesky is a LIVE public API (no export):
// scripts/convert-bluesky.mjs paginates app.bsky.graph.getFollows / getFollowers
// and hands the raw profileView arrays here. This core is pure — the network
// lives in the shell so it stays testable.
//
// DID is the permanent identity key: handles rotate, the DID doesn't, and it's
// what the ADR-04 atproto roadmap anchors on — so sourceId derives from the DID,
// and the handle lives in handles{} where a later rename won't orphan overlays.
// `edge` (mutual/following/follower) is derived from presence in the two lists
// and captured NOW — it's only knowable at ingest, before the relationship
// changes (schema §5.5). Names are display names (pseudonymous-grade), so this
// source is deliberately NOT in enrich-core's REAL_NAME_SOURCES.

const blueskyRecord = (actor, edge) => {
  const handle = String(actor.handle || '')
  // `handle.invalid` is atproto's placeholder for an account whose handle no
  // longer resolves — it is SHARED across every such account, so emitting it as
  // a handle would make the resolver glue all of them into one person (same
  // failure class as vCard's degenerate profile.php handle). The DID is the true
  // identity and merges authoritatively, so drop the placeholder from handles{}.
  const validHandle = handle && handle !== 'handle.invalid'
  const bio = String(actor.description || '').trim()
  return {
    sourceId: slugify(actor.did),
    name: String(actor.displayName || '').trim() || handle,
    emails: [],
    phones: [],
    employer: '',
    title: '',
    // `urls` is DELIBERATELY empty for Bluesky. atproto profileView has no
    // self-asserted structured link field — the only URLs are free text in the
    // bio, written by whoever controls the account (and getFollowers pulls tens
    // of thousands of strangers). resolve.mjs treats urls[] as an AUTHORITATIVE,
    // uncorroborated merge key (a linkedin.com/in URL unions unconditionally), so
    // scraping bio URLs into urls[] let any follower force-merge their account
    // onto a real contact by citing that contact's LinkedIn slug in their bio
    // (angel Run-1 C1, 2026-07-23). The URLs remain in `bio` (searchable); they
    // are just never a merge key. Only add a URL here from a future first-party,
    // self-asserted profile field, never from bio prose.
    urls: [],
    handles: validHandle ? { bluesky: handle } : {},
    did: String(actor.did),
    edge,
    bio,
    labels: [],
    connectedOn: '',
    notes: '',
  }
}

// (follows, followers) profileView arrays -> { records, warnings }. A DID in
// both lists is a `mutual`; follows-only is `following`; followers-only is
// `follower`. The same account appears in both lists for a mutual — dedup by DID.
export function blueskyRecords(follows = [], followers = []) {
  const warnings = []
  const followDids = new Set(follows.map((a) => a?.did).filter(Boolean))
  const followerDids = new Set(followers.map((a) => a?.did).filter(Boolean))
  const byDid = new Map()
  let noDid = 0
  for (const actor of [...follows, ...followers]) {
    if (!actor?.did) {
      noDid++
      continue
    }
    if (byDid.has(actor.did)) continue
    const edge =
      followDids.has(actor.did) && followerDids.has(actor.did)
        ? 'mutual'
        : followDids.has(actor.did)
          ? 'following'
          : 'follower'
    byDid.set(actor.did, blueskyRecord(actor, edge))
  }
  if (noDid) warnings.push(`skipped ${noDid} actor(s) with no DID`)
  return { records: [...byDid.values()], warnings }
}
