const assert = require('node:assert/strict')
const path = require('node:path').resolve(process.argv[2])
const { classifyWheel, createWheelClassifier, zoomFactor, zoomAround } = require(path + '/wheel.js')
const ev = (e) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, ...e })

// Mouse wheels: Chrome/Safari notches (wheelDeltaY ±120), Firefox line mode, plain 100px notches.
assert.equal(classifyWheel(ev({ deltaY: 100, wheelDeltaY: -120 })), 'zoom')
assert.equal(classifyWheel(ev({ deltaY: 4.000244140625 * 25, wheelDeltaY: -120 })), 'zoom')
assert.equal(classifyWheel(ev({ deltaY: 3, deltaMode: 1 })), 'zoom')
assert.equal(classifyWheel(ev({ deltaY: -100 })), 'zoom')
// Trackpads: two-finger scroll with fine deltas, horizontal movement or wheelDeltaY = -3 × deltaY.
assert.equal(classifyWheel(ev({ deltaY: 12, wheelDeltaY: -36 })), 'pan')
assert.equal(classifyWheel(ev({ deltaX: -8, deltaY: 1 })), 'pan')
assert.equal(classifyWheel(ev({ deltaY: 7.5 })), 'pan')
assert.equal(classifyWheel(ev({ deltaY: 4 })), 'pan')
// Pinch arrives as ctrl + wheel.
assert.equal(classifyWheel(ev({ deltaY: -2.4, ctrlKey: true })), 'pinch')
// Momentum after a trackpad scroll keeps panning, a later mouse notch zooms again.
const classify = createWheelClassifier(300)
assert.equal(classify(ev({ deltaY: 30, wheelDeltaY: -90, timeStamp: 1000 })), 'pan')
assert.equal(classify(ev({ deltaY: 120, timeStamp: 1100 })), 'pan')
assert.equal(classify(ev({ deltaY: 100, wheelDeltaY: -120, timeStamp: 2000 })), 'zoom')
// Zoom speed matches d3-zoom; pinch zooms faster per delta; zooming keeps the point under the cursor fixed.
assert.ok(zoomFactor(ev({ deltaY: -100 })) > 1 && zoomFactor(ev({ deltaY: 100 })) < 1)
assert.ok(Math.abs(zoomFactor(ev({ deltaY: -100 })) - Math.pow(2, 0.2)) < 1e-9)
assert.ok(zoomFactor(ev({ deltaY: -5, ctrlKey: true })) > zoomFactor(ev({ deltaY: -5 })))
const next = zoomAround({ x: 100, y: 50, zoom: 1 }, { x: 300, y: 200 }, 2, 0.05, 2.5)
assert.deepEqual(next, { x: -100, y: -100, zoom: 2 })
assert.equal((300 - next.x) / next.zoom, (300 - 100) / 1, 'flow point under cursor is unchanged')
assert.equal(zoomAround({ x: 0, y: 0, zoom: 2 }, { x: 0, y: 0 }, 10, 0.05, 2.5).zoom, 2.5, 'zoom is clamped')
console.log('Wheel handling: mouse zoom, trackpad pan with momentum, pinch zoom and cursor-anchored zoom passed')
