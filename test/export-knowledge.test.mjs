// pattern: functional-core
// The Project-export egress path (ADR-10). This file's output is uploaded
// wholesale to a claude.ai Project, so it is the highest-volume way data leaves
// the machine — and it was the one ADR-10 egress path with no leak test while
// docs/schema.md asserted it "never writes" the street address (review 2026-08-06).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contactBlock, skipReason } from '../scripts/export-knowledge.mjs'

const ADDRESSED = {
  name: 'Jane Wilson',
  profession: 'Nurse Practitioner',
  employer: 'Evanston Health',
  location: 'Evanston, IL',
  addresses: [{ type: 'home', street: '1400 Sherman Ave', extended: 'Apt 4', city: 'Evanston', region: 'IL', postal: '60201' }],
  emails: ['jane@example.com'],
  domains: ['nursing'],
  labels: [],
  attested: { relationship: 'cousin', realName: 'Jane Wilson Emerson' },
  connectedOn: { vcard: '2019-10-04' },
}

test('the exported block never carries a street address', () => {
  const out = contactBlock(ADDRESSED)
  for (const secret of ['1400 Sherman Ave', 'Apt 4', '60201', 'addresses'])
    assert.ok(!out.includes(secret), `Project export leaked hold-back address data: ${secret}`)
})

test('the exported block DOES carry the locality — the query it exists to answer', () => {
  assert.match(contactBlock(ADDRESSED), /Evanston, IL/)
})

test('the exported block is an allow-list: an unknown new field does not ride along', () => {
  const out = contactBlock({ ...ADDRESSED, interactions: { lastCall: 'NDA executed, 50 min' } })
  assert.ok(!out.includes('NDA executed'))
})

test('a contact with nothing to say still renders', () => {
  assert.equal(contactBlock({ name: 'Chidi Okafor' }), '(no details yet)')
})

test('control characters are stripped — this file is read as trusted knowledge', () => {
  const out = contactBlock({ ...ADDRESSED, notes: `trust me${String.fromCharCode(27)}[31m${String.fromCharCode(155)}6n` })
  assert.ok(!out.includes(String.fromCharCode(27)))
  assert.ok(!out.includes(String.fromCharCode(155)))
})

test('skipReason still gates the non-person artifacts', () => {
  assert.equal(skipReason('linkedin:jane-wilson'), 'key-shaped')
  assert.equal(skipReason('#BAL - Check Balance'), 'shortcode')
  assert.equal(skipReason('12345'), 'no-letters')
  assert.equal(skipReason('420blaze_dave'), null)
})
