const assert = require('node:assert/strict')
const dir = require('node:path').resolve(process.argv[2])
const { explainTruth, GLOSSARY } = require(dir + '/explain.js')
const { truth } = require(dir + '/board.js')

const ev = (stance, extra = {}) => ({ id: Math.random().toString(36), fact_id: 'f', stance, confidence: 0.5, source_id: 's', note: 'n', review_status: 'confirmed', retracted_at: null, ...extra })
const cases = [
  [[ev('supports'), ev('supports'), ev('supports', { review_status: 'unconfirmed' })], /2 confirmed evidence items support it.*Not counted: 1 unconfirmed item/],
  [[ev('supports'), ev('refutes')], /both ways: 1 supporting, 1 refuting/],
  [[ev('refutes'), ev('supports', { retracted_at: 'x' })], /1 confirmed evidence item refutes it.*Not counted: 1 retracted item/],
  [[ev('supports', { review_status: 'unconfirmed' })], /None of the evidence is confirmed yet/],
  [[], /no evidence yet/],
  [[ev('supports', { retracted_at: 'x' })], /All evidence was retracted/],
]
for (const [assertions, expected] of cases) {
  // The explanation always describes the status the projection computes.
  const state = truth(assertions)
  const why = explainTruth(state, assertions)
  assert.match(`${why.sentence} ${why.notCounted}`, expected, state)
}
assert.ok(['Supported', 'Disputed', 'Refuted', 'Unknown', 'Confidence', 'Review status'].every(term => GLOSSARY.some(g => g.term === term)))
console.log('Explanations: truth reasons match the projection, glossary complete passed')
{
  const { activitySentence, sentenceText } = require(require('node:path').resolve(process.argv[2]) + '/describe.js')
  const names = { u: 'j.doe', d: 'ws-0142', o: 'outlook.exe', p: 'powershell.exe', ip: '198.51.100.2', sp: 'deploy-bot', c: 'clientSecret k1', arm: 'Azure Resource Manager', loc: 'DE' }
  const kinds = { u: 'User', d: 'Device', o: 'Process', p: 'Process', ip: 'IP', sp: 'Service Principal', c: 'Credential', arm: 'Service', loc: 'Location' }
  const say = participants => sentenceText(activitySentence({ predicate: participants[0], participants: participants[1].map(([entity_id, role]) => ({ entity_id, role })) }, id => names[id], id => kinds[id]))
  const assert = require('node:assert/strict')
  assert.equal(say(['process created', [['u', 'actor'], ['u', 'identity'], ['o', 'via'], ['p', 'target'], ['d', 'other']]]), 'outlook.exe process created powershell.exe on ws-0142 as j.doe')
  assert.equal(say(['signed in', [['sp', 'identity'], ['ip', 'source'], ['c', 'tool'], ['arm', 'target'], ['loc', 'source']]]), 'deploy-bot signed in to Azure Resource Manager from 198.51.100.2 with clientSecret k1')
  console.log('Activity sentences: roles once, device, source, identity and credential passed')
}

// The original row: which column the event time came from; key fields first; who confirmed what.
{
  const { timeSourceOf, orderedKeys } = require(dir + '/rows.js')
  const { reviewKind, reviewText, addedText, reviewCounts, onBehalf } = require(dir + '/provenance.js')
  const row = { TenantId: 't', CreatedDateTime: '2026-09-17T08:00:03.000Z', TimeGenerated: '2026-09-17T08:00:05.123Z', OperationName: 'Sign-in', IPAddress: '192.0.2.5', Empty: '' }
  assert.equal(timeSourceOf(row, '2026-09-17T08:00:05.123Z'), 'TimeGenerated')
  assert.equal(timeSourceOf(row, '2026-09-17T08:00:03.000Z'), 'CreatedDateTime')
  assert.equal(timeSourceOf({ 'TimeGenerated [UTC]': '2026-09-17 08:00:05' }, '2026-09-17T08:00:05.000Z'), 'TimeGenerated [UTC]')
  assert.equal(timeSourceOf(row, '2026-01-01T00:00:00.000Z'), null)
  assert.deepEqual(orderedKeys(row).slice(0, 2), ['OperationName', 'IPAddress'])
  assert.ok(!orderedKeys(row).includes('Empty'))
  const base = { id: 'x', retracted_at: null, review_status: 'confirmed' }
  assert.equal(reviewKind({ ...base, review_note: 'Parsed from the original log row by the import' }), 'import', 'legacy import confirmation')
  assert.equal(reviewKind({ ...base, review_kind: 'agent', reviewer_name: 'Claude' }), 'agent')
  assert.match(reviewText({ ...base, review_kind: 'agent', reviewer_name: 'Claude' }), /not checked by an analyst/)
  assert.equal(reviewText({ ...base, review_kind: 'analyst', reviewer_name: 'Jo' }), 'Reviewed by Jo')
  assert.equal(addedText({ created_by: 'Claude', created_via: 'MCP' }), 'Claude via MCP')
  assert.equal(addedText({ created_by: 'Import', created_via: 'MCP' }), 'Import by an agent via MCP')
  // The analyst whose board token the agent used.
  assert.equal(addedText({ created_by: 'MCP (Gregor)', created_via: 'MCP' }), 'Agent via MCP (Gregor)')
  assert.equal(addedText({ created_by: 'Claude (Gregor)', created_via: 'MCP' }), 'Claude via MCP (Gregor)')
  assert.equal(addedText({ created_by: 'Import (Gregor)', created_via: 'REST' }), 'Import by an agent via REST (Gregor)')
  assert.equal(reviewText({ review_status: 'confirmed', review_kind: 'agent', reviewer_name: 'REST (Gregor)' }), 'Confirmed by an agent via REST (Gregor), not checked by an analyst')
  assert.equal(reviewText({ review_status: 'confirmed', review_kind: 'agent', reviewer_name: null }), 'Confirmed by an agent via REST/MCP, not checked by an analyst')
  assert.equal(onBehalf('MCP', 'MCP', 'Gregor'), 'MCP (Gregor)')
  assert.equal(onBehalf('API', 'REST', 'Gregor'), 'REST (Gregor)')
  assert.equal(onBehalf('Claude (Gregor)', 'MCP', 'Gregor'), 'Claude (Gregor)', 'never twice')
  assert.equal(addedText({ created_by: 'Import', created_via: 'Import' }), 'File import by an analyst')
  assert.deepEqual(reviewCounts([{ ...base, review_kind: 'import' }, { ...base, review_status: 'unconfirmed' }, { ...base, review_kind: 'analyst' }]), { import: 1, analyst: 1, agent: 0, open: 1 })
  console.log('Original rows: event time column, field order; evidence provenance passed')
}
