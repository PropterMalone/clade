// pattern: functional-core
// Pins the LinkedIn converter against the comma-split failures found on real
// data 2026-07-18 (quoted "Acme, Inc." / "Barlow, CPA" shifted columns and
// produced junk sourceIds like "cpa").

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { linkedinRecords, parseCsv, parseConnectedOn, splitCredentials } from '../scripts/lib/ingest.mjs'

const HEADER = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On'
const PREAMBLE = 'Notes:\n"When exporting your connection data, you may notice missing emails, etc."\n\n'

test('parseCsv keeps quoted commas, escaped quotes, and CRLF intact', () => {
  assert.deepEqual(parseCsv('a,"b, c",d'), [['a', 'b, c', 'd']])
  assert.deepEqual(parseCsv('a,"say ""hi""",c'), [['a', 'say "hi"', 'c']])
  assert.deepEqual(parseCsv('a,b\r\nc,d'), [['a', 'b'], ['c', 'd']])
  assert.deepEqual(parseCsv('a,"multi\nline",c'), [['a', 'multi\nline', 'c']])
})

test('quoted company suffix stays in the employer column', () => {
  const csv = `${PREAMBLE}${HEADER}\nNick,Dubinskiy,https://www.linkedin.com/in/nick-d-1,,"Ntiva, Inc.",CTO,25 May 2023`
  const { records } = linkedinRecords(csv)
  assert.equal(records[0].employer, 'Ntiva, Inc.')
  assert.equal(records[0].title, 'CTO')
  assert.equal(records[0].sourceId, 'nick-d-1')
  assert.equal(records[0].connectedOn, '2023-05-25')
})

test('credentialed last name: clean display name, credential kept as label, real sourceId', () => {
  const csv = `${PREAMBLE}${HEADER}\nDavid,"Barlow, CPA",https://www.linkedin.com/in/david-barlow-cpa-474543188,,CohnReznick LLP,Tax Manager,25 May 2023`
  const { records } = linkedinRecords(csv)
  const r = records[0]
  assert.equal(r.name, 'David Barlow')
  assert.deepEqual(r.labels, ['CPA'])
  assert.equal(r.sourceId, 'david-barlow-cpa-474543188')
  assert.equal(r.employer, 'CohnReznick LLP')
  assert.equal(r.title, 'Tax Manager')
})

test('splitCredentials handles multiples and leaves real compound names alone', () => {
  assert.deepEqual(splitCredentials('Molnar, MD, CFE'), { lastName: 'Molnar', credentials: ['MD', 'CFE'] })
  assert.deepEqual(splitCredentials('Smith'), { lastName: 'Smith', credentials: [] })
  // a comma segment that is NOT credential-shaped stays part of the name
  assert.deepEqual(splitCredentials('Windsor, Duke of Kent'), { lastName: 'Windsor, Duke of Kent', credentials: [] })
})

test('splitCredentials catches dotted, slashed, and all-caps credential forms', () => {
  assert.deepEqual(splitCredentials('Boyan, Ph.D.'), { lastName: 'Boyan', credentials: ['Ph.D'] })
  assert.deepEqual(splitCredentials('Schultz, OTR/L'), { lastName: 'Schultz', credentials: ['OTR/L'] })
  assert.deepEqual(splitCredentials('Telles, M.A.'), { lastName: 'Telles', credentials: ['M.A'] })
  assert.deepEqual(
    splitCredentials('Hoffman, M.Acc., CPA/ABV/CFF, CVA, CFE, CAMS, CRT, PI'),
    { lastName: 'Hoffman', credentials: ['M.Acc', 'CPA/ABV/CFF', 'CVA', 'CFE', 'CAMS', 'CRT', 'PI'] },
  )
  assert.deepEqual(splitCredentials('Cornell, ENV SP'), { lastName: 'Cornell', credentials: ['ENV SP'] })
})

test('missing URL falls back to a name slug; duplicate slugs stay unique', () => {
  const csv = `${PREAMBLE}${HEADER}\nJane,Doe,,,Acme,CEO,01 Jun 2015\nJane,Doe,,,Other,CTO,02 Jun 2015`
  const { records } = linkedinRecords(csv)
  assert.equal(records[0].sourceId, 'jane-doe')
  assert.equal(records[1].sourceId, 'jane-doe-x')
})

test('nameless rows warn and skip; garbage input yields zero records with a warning', () => {
  const csv = `${PREAMBLE}${HEADER}\n,,https://www.linkedin.com/in/ghost,,Acme,CEO,01 Jun 2015`
  const out = linkedinRecords(csv)
  assert.equal(out.records.length, 0)
  assert.equal(out.warnings.length, 1)
  const junk = linkedinRecords('this,is,not\na,linkedin,export')
  assert.equal(junk.records.length, 0)
  assert.match(junk.warnings[0], /First Name/)
})

test('parseConnectedOn formats', () => {
  assert.equal(parseConnectedOn('08 Mar 2026'), '2026-03-08')
  assert.equal(parseConnectedOn('1 Jan 2010'), '2010-01-01')
  assert.equal(parseConnectedOn('garbage'), '')
})

test('facebookFriendsRecords parses the HTML export', async () => {
  const { facebookFriendsRecords } = await import('../scripts/lib/ingest.mjs')
  const html = `<html><body><main><section class="_a6-g"><h2 class="x" id="a">Brandon McGreevy</h2><footer><div class="_a72d">Oct 19, 2025 1:47:55 pm</div></footer></section><section class="_a6-g"><h2 id="b">Anne &amp; Marie O&#039;Neil</h2><footer><div class="_a72d">Jul 20, 2025 3:35:46 pm</div></footer></section></main></body></html>`
  const { records, warnings } = facebookFriendsRecords(html)
  assert.equal(warnings.length, 0)
  assert.equal(records.length, 2)
  assert.deepEqual(
    { name: records[0].name, connectedOn: records[0].connectedOn, sourceId: records[0].sourceId },
    { name: 'Brandon McGreevy', connectedOn: '2025-10-19', sourceId: 'brandon-mcgreevy' },
  )
  assert.equal(records[1].name, "Anne & Marie O'Neil")
})

test('facebookFriendsRecords parses the JSON export and keeps same-name friends distinct', async () => {
  const { facebookFriendsRecords } = await import('../scripts/lib/ingest.mjs')
  const json = JSON.stringify({ friends_v2: [
    { name: 'John Smith', timestamp: 1290000000 },
    { name: 'John Smith', timestamp: 1590000000 },
  ] })
  const { records } = facebookFriendsRecords(json)
  assert.equal(records.length, 2)
  assert.notEqual(records[0].sourceId, records[1].sourceId)
  assert.equal(records[0].connectedOn, '2010-11-17')
})

test('facebookFriendsRecords warns on garbage', async () => {
  const { facebookFriendsRecords } = await import('../scripts/lib/ingest.mjs')
  assert.equal(facebookFriendsRecords('<html>nothing here</html>').warnings.length, 1)
  assert.equal(facebookFriendsRecords('{"wrong": true}').warnings.length, 1)
})

test('googleContactsRecords: ::: splits, label/photo leaks stay out of emails', async () => {
  const { googleContactsRecords } = await import('../scripts/lib/ingest.mjs')
  const header = 'First Name,Middle Name,Last Name,File As,Notes,Photo,Labels,E-mail 1 - Label,E-mail 1 - Value,E-mail 2 - Label,E-mail 2 - Value,Phone 1 - Label,Phone 1 - Value,Organization Name,Organization Title,Website 1 - Value'
  const rows = [
    'Sam,,Whitfield,,,,* myContacts,,a@x.edu ::: b@y.org ::: c@z.com,,,Mobile,555-0100,Acme,CEO,',
    'Robin,,Vasquez,,,https://lh3.googleusercontent.com/photo,"Super Bowl ::: Games Night ::: * friends ::: * myContacts ::: * starred",,* Other,,,Home,555-0101 ::: 555-0102,,,',
  ].join('\n')
  const { records, warnings } = googleContactsRecords(`${header}\n${rows}`)
  assert.equal(records.length, 2)
  assert.deepEqual(records[0].emails, ['a@x.edu', 'b@y.org', 'c@z.com'])
  assert.equal(records[0].employer, 'Acme')
  assert.deepEqual(records[1].emails, [], 'leaked label must not become an email')
  assert.deepEqual(records[1].labels, ['Super Bowl', 'Games Night', 'friends'])
  assert.deepEqual(records[1].phones, ['555-0101', '555-0102'])
  assert.ok(warnings.some((w) => /dropping non-email/.test(w)))
  assert.equal(records[0].sourceId, 'sam-whitfield')
})

test('googleContactsRecords: duplicate names get legacy numeric suffixes', async () => {
  const { googleContactsRecords } = await import('../scripts/lib/ingest.mjs')
  const header = 'First Name,Middle Name,Last Name,File As,E-mail 1 - Value'
  const { records } = googleContactsRecords(`${header}\nChris,,Barraza,,a@x.com\nChris,,Barraza,,b@y.com`)
  assert.deepEqual(records.map((r) => r.sourceId), ['chris-barraza', 'chris-barraza-2'])
})

test('googleContactsRecords rejects a non-google csv', async () => {
  const { googleContactsRecords } = await import('../scripts/lib/ingest.mjs')
  assert.match(googleContactsRecords('foo,bar\n1,2').warnings[0], /First Name/)
})

test('googleContactsRecords extracts RFC-822 angle-bracket emails', async () => {
  const { googleContactsRecords } = await import('../scripts/lib/ingest.mjs')
  const header = 'First Name,Middle Name,Last Name,File As,E-mail 1 - Value'
  const { records, warnings } = googleContactsRecords(`${header}\nWanda,,Frost,,"Frost, Wanda (ACME) <wanda.frost@example.org>"`)
  assert.deepEqual(records[0].emails, ['wanda.frost@example.org'])
  assert.equal(warnings.length, 0)
})

test('dateless facebook friend keeps empty date and never steals the next section', async () => {
  const { facebookFriendsRecords } = await import('../scripts/lib/ingest.mjs')
  const html = `<main><section class="_a6-g"><h2 id="a">No Date Person</h2></section><section class="_a6-g"><h2 id="b">Has Date Person</h2><footer><div class="_a72d">Oct 19, 2025 1:47:55 pm</div></footer></section></main>`
  const { records, warnings } = facebookFriendsRecords(html)
  assert.equal(records.length, 2)
  assert.equal(records[0].connectedOn, '')
  assert.equal(records[1].connectedOn, '2025-10-19')
  assert.ok(warnings.some((w) => /No Date Person/.test(w)))
})

test('generational suffixes stay in the name, not credentials', async () => {
  const { splitCredentials } = await import('../scripts/lib/ingest.mjs')
  assert.deepEqual(splitCredentials('Smith, III'), { lastName: 'Smith, III', credentials: [] })
  assert.deepEqual(splitCredentials('Jones, JR'), { lastName: 'Jones, JR', credentials: [] })
  assert.deepEqual(splitCredentials('Barlow, CPA'), { lastName: 'Barlow', credentials: ['CPA'] })
})

// String.raw so the fixture's literal backslashes (\, \n in NOTE, folding) reach
// the parser unmangled — exactly what's on disk in a real .vcf.
const VCF = String.raw`BEGIN:VCARD
VERSION:3.0
PRODID:-//Apple Inc.//macOS 14//EN
N:Wilson;Jane;Q;;
FN:Jane Q Wilson
ORG:Deloitte;Strategy
TITLE:Senior Manager
item1.EMAIL;type=INTERNET;type=HOME;type=pref:jane@example.com
item1.X-ABLabel:_$!<Home>!$_
EMAIL;type=INTERNET;type=WORK:jane.wilson@deloitte.com
TEL;type=CELL;type=VOICE;type=pref:+1 (555) 123-4567
item2.URL;type=pref:https://janewilson.example
X-SOCIALPROFILE;type=twitter:https://twitter.com/janeqw
NOTE:Met at the\, conference; loves\n dogs
PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQEAYABgAAD/aaaaaaaaaaaaaaaa
 bbbbbbbbbbbbbbbbccccccccccccccccdddddddddddddddd
UID:urn:uuid:AAAA-1111
END:VCARD
BEGIN:VCARD
VERSION:4.0
N:Okafor;Chidi;;;
TEL;type=cell:555-0000
END:VCARD
BEGIN:VCARD
FN:Chidi Okafor
EMAIL:chidi@work.example
END:VCARD
BEGIN:VCARD
FN:Bad Email Bob
EMAIL:not-an-email
TEL:555-9999
END:VCARD`

test('vcardRecords parses an Apple card: folding, itemN, escapes, ORG, social, drops PHOTO', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const { records } = vcardRecords(VCF)
  const jane = records[0]
  assert.equal(jane.name, 'Jane Q Wilson')
  assert.deepEqual(jane.emails, ['jane@example.com', 'jane.wilson@deloitte.com'])
  assert.deepEqual(jane.phones, ['+1 (555) 123-4567'])
  // social-profile URLs are preserved in urls[] too, so they can merge cross-source
  assert.deepEqual(jane.urls, ['https://janewilson.example', 'https://twitter.com/janeqw'])
  assert.equal(jane.employer, 'Deloitte') // first ORG component, department dropped
  assert.equal(jane.title, 'Senior Manager')
  assert.deepEqual(jane.handles, { twitter: 'janeqw' })
  assert.equal(jane.notes, 'Met at the, conference; loves\n dogs') // \, -> comma, \n -> newline
  assert.equal(jane.sourceId, 'aaaa-1111', 'UID (urn:uuid stripped) drives a stable id; folded PHOTO did not corrupt it')
  assert.ok(!JSON.stringify(jane).includes('9j/4AAQ'), 'PHOTO blob must not leak into any field')
})

test('vcardRecords assembles a name from N when FN is absent, and dedupes same names', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const { records } = vcardRecords(VCF)
  assert.equal(records[1].name, 'Chidi Okafor') // N:Okafor;Chidi -> "Chidi Okafor"
  assert.deepEqual([records[1].sourceId, records[2].sourceId], ['chidi-okafor', 'chidi-okafor-2'])
})

test('vcardRecords drops a non-email EMAIL value with a warning but keeps the named card', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const { records, warnings } = vcardRecords(VCF)
  const bob = records[3]
  assert.equal(bob.name, 'Bad Email Bob')
  assert.deepEqual(bob.emails, [])
  assert.deepEqual(bob.phones, ['555-9999'])
  assert.ok(warnings.some((w) => /dropping non-email/.test(w)))
  assert.equal(records.length, 4)
})

test('vcardRecords rejects a non-vcard file', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const { records, warnings } = vcardRecords('just some text\nno cards here')
  assert.equal(records.length, 0)
  assert.match(warnings[0], /BEGIN:VCARD/)
})

// --- vCard hardening (from the /angel review) --------------------------------

test('vcardRecords parses CRLF + BOM identically to LF — the real on-disk Apple shape', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const lf = vcardRecords(VCF).records
  const crlfBom = vcardRecords(`﻿${VCF.replace(/\n/g, '\r\n')}`).records
  assert.deepEqual(crlfBom, lf, 'CRLF line endings + a leading BOM must yield identical records')
})

test('vcardRecords: a mid-stream BOM (2nd+ file in a merge) does not swallow that card', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const a = 'BEGIN:VCARD\nFN:First File Person\nEMAIL:a@x.com\nEND:VCARD'
  const b = '﻿BEGIN:VCARD\nFN:Second File Person\nEMAIL:b@y.com\nEND:VCARD' // BOM-prefixed, as the shell join produces
  const { records } = vcardRecords(`${a}\n${b}`)
  assert.deepEqual(records.map((r) => r.name), ['First File Person', 'Second File Person'])
})

test('vcardRecords: a degenerate profile.php URL does NOT become a shared merge handle', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const card = (name, id) =>
    `BEGIN:VCARD\nFN:${name}\nX-SOCIALPROFILE;type=facebook:https://www.facebook.com/profile.php?id=${id}\nEND:VCARD`
  const { records } = vcardRecords(`${card('Alice Jones', '111')}\n${card('Bob Smith', '222')}`)
  // The identity is the id= param, never the shared "profile.php" segment that would glue strangers.
  assert.equal(records[0].handles.facebook, '111')
  assert.equal(records[1].handles.facebook, '222')
  assert.notEqual(records[0].handles.facebook, records[1].handles.facebook)
})

test('vcardRecords: a bare-host profile URL yields no handle (nothing to glue on)', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const { records } = vcardRecords('BEGIN:VCARD\nFN:Homepage Only\nX-SOCIALPROFILE;type=facebook:https://www.facebook.com/\nEND:VCARD')
  assert.deepEqual(records[0].handles, {})
  assert.deepEqual(records[0].urls, ['https://www.facebook.com/']) // URL still preserved
})

test('vcardRecords: a LinkedIn social-profile URL lands in urls[] so it can merge cross-source', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const { records } = vcardRecords('BEGIN:VCARD\nFN:Jane Wilson\nX-SOCIALPROFILE;type=linkedin:https://www.linkedin.com/in/janeqw\nEND:VCARD')
  assert.ok(records[0].urls.includes('https://www.linkedin.com/in/janeqw'), 'the LinkedIn URL must reach urls[] (resolver keys linkedin: off urls)')
})

test('vcardRecords: IMPP bare-scheme handle drops the scheme prefix', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const { records } = vcardRecords('BEGIN:VCARD\nFN:Chat User\nIMPP;X-SERVICE-TYPE=Skype:skype:realuser\nEND:VCARD')
  assert.equal(records[0].handles.skype, 'realuser') // not "skype:realuser"
})

test('vcardRecords: one malformed %-escape does not abort the whole import', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const good1 = 'BEGIN:VCARD\nFN:Before\nEMAIL:before@x.com\nEND:VCARD'
  const poison = 'BEGIN:VCARD\nFN:Poison\nX-SOCIALPROFILE;type=twitter:https://twitter.com/us%zz\nEND:VCARD'
  const good2 = 'BEGIN:VCARD\nFN:After\nEMAIL:after@y.com\nEND:VCARD'
  const { records } = vcardRecords(`${good1}\n${poison}\n${good2}`)
  assert.deepEqual(records.map((r) => r.name), ['Before', 'Poison', 'After'], 'the bad card degrades, the batch survives')
})

test('vcardRecords: same UID appearing twice keeps one record and warns', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const card = 'BEGIN:VCARD\nFN:Dupe Person\nEMAIL:d@x.com\nUID:urn:uuid:SAME-1\nEND:VCARD'
  const { records, warnings } = vcardRecords(`${card}\n${card}`)
  assert.equal(records.length, 1)
  assert.equal(records[0].sourceId, 'same-1')
  assert.ok(warnings.some((w) => /duplicate UID/.test(w)))
})

test('vcardRecords: CATEGORIES becomes labels, escaped comma preserved, system groups dropped', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const { records } = vcardRecords(String.raw`BEGIN:VCARD
FN:Labeled Person
CATEGORIES:myContacts,Family\, close,Kickball,starred
END:VCARD`)
  assert.deepEqual(records[0].labels, ['Family, close', 'Kickball']) // myContacts/starred filtered, \, kept
})

test('vcardRecords: mailto:/tel: schemes are stripped so merge keys match other sources', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const { records } = vcardRecords('BEGIN:VCARD\nFN:Scheme Person\nEMAIL;VALUE=uri:mailto:jane@x.com\nTEL;VALUE=uri:tel:+15550100\nEND:VCARD')
  assert.deepEqual(records[0].emails, ['jane@x.com'])
  assert.deepEqual(records[0].phones, ['+15550100'])
})

test('vcardRecords: quoted-printable bare-param form fires the warning', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const { warnings } = vcardRecords('BEGIN:VCARD\nFN;QUOTED-PRINTABLE:=4A=61=6E=65\nEMAIL:jane@x.com\nEND:VCARD')
  assert.ok(warnings.some((w) => /quoted-printable/i.test(w)), 'bare-param QP (not just ENCODING=) must be detected')
})

test('vcardRecords: a truncated last card (no END:VCARD) is salvaged with a warning', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const { records, warnings } = vcardRecords('BEGIN:VCARD\nFN:Complete\nEMAIL:c@x.com\nEND:VCARD\nBEGIN:VCARD\nFN:Truncated\nEMAIL:t@y.com')
  assert.deepEqual(records.map((r) => r.name), ['Complete', 'Truncated'])
  assert.ok(warnings.some((w) => /no END:VCARD/.test(w)))
})

test('vcardRecords: a card with no name and no email is skipped with an identifying hint', async () => {
  const { vcardRecords } = await import('../scripts/lib/ingest.mjs')
  const { records, warnings } = vcardRecords('BEGIN:VCARD\nTEL:555-0000\nUID:urn:uuid:ORPHAN-9\nEND:VCARD')
  assert.equal(records.length, 0)
  assert.ok(warnings.some((w) => /skipping card.*ORPHAN-9/.test(w)), 'the skip warning must name the card')
})
