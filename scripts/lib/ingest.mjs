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
