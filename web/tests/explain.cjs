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
