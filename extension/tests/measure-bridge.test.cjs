// Unit tests for extension/content/bridge/measure-bridge.js's pure helpers
// — origin/request validation, payload-size/shape limits, concurrency
// (duplicate Finish) handling, and explicit ground/surface mode
// resolution. These run under plain Node (no chrome global, no DOM)
// because measure-bridge.js guards its real listener registration behind
// a chrome.runtime.id check (see its header comment) and exports its
// internals via module.exports whenever `module` exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const bridge = require('../content/bridge/measure-bridge.js');

test('readFinishEvent ignores events not from the expected window/origin', () => {
  const win = {};
  const otherWin = {};
  const good = { source: win, origin: 'https://turnkeycrm.net', data: { source: 'turnkey-measure-workspace', type: 'TURNKEY_MEASURE_FINISH', requestId: 'r1' } };
  assert.ok(bridge.readFinishEvent(good, { expectedWindow: win, expectedOrigin: 'https://turnkeycrm.net' }));

  const wrongWindow = { ...good, source: otherWin };
  assert.equal(bridge.readFinishEvent(wrongWindow, { expectedWindow: win, expectedOrigin: 'https://turnkeycrm.net' }), null);

  const wrongOrigin = { ...good, origin: 'https://evil.example' };
  assert.equal(bridge.readFinishEvent(wrongOrigin, { expectedWindow: win, expectedOrigin: 'https://turnkeycrm.net' }), null);
});

test('readFinishEvent ignores unrelated message shapes/sources', () => {
  const win = {};
  const base = { source: win, origin: 'https://turnkeycrm.net' };
  assert.equal(bridge.readFinishEvent({ ...base, data: null }, { expectedWindow: win, expectedOrigin: 'https://turnkeycrm.net' }), null);
  assert.equal(bridge.readFinishEvent({ ...base, data: { source: 'some-other-widget', type: 'TURNKEY_MEASURE_FINISH' } }, { expectedWindow: win, expectedOrigin: 'https://turnkeycrm.net' }), null);
  assert.equal(bridge.readFinishEvent({ ...base, data: { source: 'turnkey-measure-workspace', type: 'SOMETHING_ELSE' } }, { expectedWindow: win, expectedOrigin: 'https://turnkeycrm.net' }), null);
});

test('validatePayloadShape rejects malformed/undersized/oversized traces', () => {
  const okArea = { requestId: 'r1', kind: 'area', category: 'roof', points: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }, { lat: 3, lng: 1 }] };
  assert.equal(bridge.validatePayloadShape(okArea), null);

  assert.ok(bridge.validatePayloadShape({ ...okArea, requestId: '' }));
  assert.ok(bridge.validatePayloadShape({ ...okArea, kind: 'triangle' }));
  assert.ok(bridge.validatePayloadShape({ ...okArea, points: [{ lat: 1, lng: 1 }] })); // below area minimum of 3
  assert.ok(bridge.validatePayloadShape({ ...okArea, points: [{ lat: 1, lng: 1 }, { lat: 'x', lng: 2 }, { lat: 3, lng: 1 }] })); // malformed point
  assert.ok(bridge.validatePayloadShape({ ...okArea, points: Array.from({ length: 2001 }, (_, i) => ({ lat: i, lng: i })) })); // too many points

  // House-style traces: 'perimeter' uses the SAME closed-loop minimum (3) as 'area'.
  const okPerimeter = { ...okArea, kind: 'perimeter' };
  assert.equal(bridge.validatePayloadShape(okPerimeter), null);

  const okLine = { requestId: 'r2', kind: 'line', category: 'fence', points: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }] };
  assert.equal(bridge.validatePayloadShape(okLine), null);
  assert.ok(bridge.validatePayloadShape({ ...okLine, points: [{ lat: 1, lng: 1 }] })); // below line minimum of 2
});

test('resolveMode is explicit — it never infers surface mode, it only validates/defaults what the page already chose', () => {
  assert.equal(bridge.resolveMode('ground'), 'ground');
  assert.equal(bridge.resolveMode('surface'), 'surface');
  assert.equal(bridge.resolveMode(undefined), 'ground'); // missing — safe default, not inferred from altitude data
  assert.equal(bridge.resolveMode('auto-detect-please'), 'ground'); // unrecognized — safe default
});

test('createDedupeTracker rejects a requestId it has already seen (duplicate/concurrent Finish clicks)', () => {
  const tracker = bridge.createDedupeTracker();
  assert.equal(tracker.shouldProcess('r1'), true);
  assert.equal(tracker.shouldProcess('r1'), false);
  assert.equal(tracker.shouldProcess('r2'), true);
});

test('computeResult calls geometry.js with the explicitly-requested kind/mode and surfaces its validation errors', async () => {
  const calls = [];
  const fakeGeometry = {
    validatePoints: (points, opts) => { calls.push(['validatePoints', points, opts]); },
    measureGeometry: (points, opts) => { calls.push(['measureGeometry', points, opts]); return { value: 42, unit: 'm²', groundArea: 42, method: 'geodesic', points }; }
  };
  const msg = { kind: 'area', mode: 'ground', points: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }, { lat: 3, lng: 1 }] };
  const result = await bridge.computeResult(fakeGeometry, msg);
  assert.equal(result.value, 42);
  assert.deepEqual(calls[0][2], { kind: 'area', mode: 'ground' });
  assert.deepEqual(calls[1][2], { kind: 'area', mode: 'ground' });

  // Requesting 'surface' is passed straight through — computeResult itself
  // never inspects point altitude to decide; geometry.js's own
  // validatePoints() is the single place that enforces "every vertex
  // needs a real altitude for surface mode".
  const surfaceMsg = { kind: 'area', mode: 'surface', points: msg.points };
  await bridge.computeResult(fakeGeometry, surfaceMsg);
  assert.deepEqual(calls[2][2], { kind: 'area', mode: 'surface' });

  const throwingGeometry = {
    validatePoints: () => { throw new Error('3D surface measurements need a valid elevation at every point.'); },
    measureGeometry: () => { throw new Error('should not be called'); }
  };
  await assert.rejects(() => bridge.computeResult(throwingGeometry, surfaceMsg), /valid elevation/);
});

test('computeResult against the REAL extension/geometry.js: house perimeter, ground area, and a rejected surface request missing altitude', async () => {
  const geometry = await import(path.join(__dirname, '..', 'geometry.js'));

  const roofGround = await bridge.computeResult(geometry, {
    kind: 'area',
    mode: 'ground',
    points: [{ lat: -36.8485, lng: 174.7633 }, { lat: -36.8484, lng: 174.7634 }, { lat: -36.8483, lng: 174.7632 }]
  });
  assert.equal(roofGround.unit, 'm²');
  assert.ok(roofGround.value > 0);

  // House category traces a closed outline but is priced/measured by its
  // PERIMETER, in metres, not its area (see app.js's CATEGORIES + quote.js's
  // unit-aware service filter).
  const housePerimeter = await bridge.computeResult(geometry, {
    kind: 'perimeter',
    mode: 'ground',
    points: [{ lat: -36.8485, lng: 174.7633 }, { lat: -36.8484, lng: 174.7634 }, { lat: -36.8483, lng: 174.7632 }]
  });
  assert.equal(housePerimeter.unit, 'm');
  assert.ok(housePerimeter.value > 0);

  // Requesting 'surface' without a real altitude on every vertex must fail
  // closed, not silently fall back to ground or invent a height.
  await assert.rejects(
    () => bridge.computeResult(geometry, { kind: 'area', mode: 'surface', points: roofGround.points }),
    /elevation/
  );
});
