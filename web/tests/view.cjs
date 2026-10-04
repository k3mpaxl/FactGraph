const assert = require('node:assert/strict')
const { parseView } = require(require('node:path').resolve(process.argv[2]) + '/savedView.js')

// The analyst's view survives a reload; malformed entries fall back to defaults; the old global lens is taken over once.
{
  const view = { stateFilter: 'disputed', lens: { layers: ['identity', 'network'], collapseActivities: true, showLanes: false }, from: '2026-09-01T00:00', to: '',
    includeUndated: false, showTime: true, selection: { kind: 'fact', id: 'f1' }, viewport: { x: -120, y: 40, zoom: 0.6 } }
  assert.deepEqual(parseView(JSON.stringify(view)), view)
  const broken = parseView('{"stateFilter":"evil","lens":{"layers":["nope","identity"]},"selection":{"kind":"x","id":1},"viewport":{"zoom":0},"from":5}')
  assert.equal(broken.stateFilter, 'all'); assert.deepEqual(broken.lens.layers, ['identity'])
  assert.equal(broken.selection, null); assert.equal(broken.viewport, null); assert.equal(broken.from, ''); assert.equal(broken.includeUndated, true)
  assert.equal(parseView('not json').stateFilter, 'all')
  const legacy = JSON.stringify({ layers: ['cloud'], collapseActivities: false, showLanes: true })
  assert.deepEqual(parseView(null, legacy).lens, { layers: ['cloud'], collapseActivities: false, showLanes: true }, 'boards without a saved view start from the old global lens')
  assert.deepEqual(parseView(JSON.stringify(view), legacy).lens, view.lens, 'a saved board view wins over the old global lens')
  console.log('Saved view: round trip, defaults and legacy lens passed')
}
