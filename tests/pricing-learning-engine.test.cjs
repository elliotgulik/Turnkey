const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const engine = require('../pricing-learning-engine.js');
const line = { lineKey: 'roof-0', svc: 'roof', unit: 'm²', quantity: 100, baselinePrice: 100, marginFloor: 60, storeys: 1, access: 'standard' };
const samples = (n = 5, overrides = {}) => Array.from({ length: n }, (_, i) => ({ ...line,
  quoteKey: `quote-${i}`, jobId: `job-${i}`, chosenPrice: 120, reason: 'pricing_correction', ...overrides }));
const rec = (observations = samples(), overrides = {}) => engine.recommend({ lines: [line], observations, ...overrides })[0];

test('UMD browser global and CJS expose the same pure API', () => {
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../pricing-learning-engine.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.TK_PRICE_LEARNING.recommend, 'function');
  assert.equal(sandbox.TK_PRICE_LEARNING.modelVersion, 1);
});
test('five distinct quotes shrink the median toward baseline; adjustment is dollars', () => {
  const r = rec();
  assert.equal(r.recommendedPrice, 110);
  assert.equal(r.learnedAdjustment, 10);
  assert.equal(r.sampleCount, 5);
  assert.match(r.explanation, /median.*shrunk/);
});
test('fewer than five and repeated quotes never satisfy the threshold', () => {
  assert.equal(rec(samples(4)).recommendedPrice, 100);
  assert.equal(rec(samples(30, { quoteKey: 'same', jobId: 'same' })).sampleCount, 1);
  assert.equal(rec(samples(30, { quoteKey: 'same' })).sampleCount, 1);
  const rows = samples(20, { jobId: 'same' });
  assert.equal(rec(rows).sampleCount, 1);
});
test('multiple comparable lines on a quote have one median vote', () => {
  const rows = samples().flatMap(o => [o, { ...o }, { ...o }]);
  assert.equal(rec(rows).sampleCount, 5);
});
test('discount, measurement correction and extra work cannot contaminate prices', () => {
  for (const reason of ['discount', 'measurement_correction', 'extra_work', 'unrecognized']) {
    assert.equal(rec(samples(20, { reason, chosenPrice: 20 })).sampleCount, 0);
  }
});
test('measurement learning uses raw measured quantity and requires explicit verification', () => {
  const rows = samples(5, { reason: 'measurement_correction', quantity: 120, measuredQuantity: 100,
    verifiedQuantity: 120, measurementReason: 'site_measurement' });
  const r = rec(rows);
  assert.equal(r.sampleCount, 0);
  assert.equal(r.measurement.factor, 1.1);
  assert.equal(r.measurement.suggestedQuantity, 110);
  assert.equal(rec(rows.map(o => ({ ...o, measurementReason: null }))).measurement.sampleCount, 0);
  assert.equal(rec(rows.map(o => ({ ...o, measuredQuantity: null }))).measurement.sampleCount, 0);
});
test('context matches service, unit, storeys and access exactly', () => {
  for (const patch of [{ svc: 'deck' }, { unit: 'm' }, { storeys: 2 }, { access: 'hard' }]) {
    assert.equal(rec(samples(5, patch)).sampleCount, 0);
  }
  assert.equal(rec(samples(5, { reason: 'difficult_access', access: 'hard' })).sampleCount, 0);
  assert.equal(rec(samples(5, { reason: 'difficult_access', access: 'hard' }), { lines: [{ ...line, access: 'hard' }] }).sampleCount, 5);
});
test('one extreme outlier cannot shift the median', () => {
  const rows = samples(); rows[0].chosenPrice = 1000000;
  assert.equal(rec(rows).recommendedPrice, 110);
});
test('maximum adjustment is bounded to 35 percent even with invalid settings', () => {
  assert.equal(rec(samples(50, { chosenPrice: 10000 }), { settings: { maxAdjustment: 10 } }).recommendedPrice, 135);
  assert.equal(rec(samples(50, { chosenPrice: 1 }), { settings: { maxAdjustment: 0.1 } }).recommendedPrice, 90);
});
test('target margin floor ALWAYS applies, including disabled and insufficient learning', () => {
  for (const settings of [{ enabled: false }, {}, { minSamples: 50 }]) {
    const r = rec([], { lines: [{ ...line, marginFloor: 150.001 }], settings });
    assert.equal(r.recommendedPrice, 150.01);
    assert.equal(r.learnedAdjustment, 50.01);
    assert.match(r.explanation, /floor/);
  }
  assert.equal(rec(samples(10, { chosenPrice: 20 }), { lines: [{ ...line, marginFloor: 99 }] }).recommendedPrice, 99);
});
test('business filtering and mixed tenant input fail closed', () => {
  const rows = [...samples(5, { businessId: 'a' }), ...samples(10, { businessId: 'b', chosenPrice: 20 })];
  assert.equal(rec(rows, { businessId: 'a' }).recommendedPrice, 110);
  assert.equal(rec(rows).sampleCount, 0);
});
test('snake case persisted observations/settings are supported', () => {
  const rows = samples().map(o => ({ svc: o.svc, unit: o.unit, quantity: o.quantity, storeys: o.storeys, access: o.access,
    quote_key: o.quoteKey, job_id: o.jobId, baseline_price: 100, chosen_price: 120, reason: o.reason }));
  assert.equal(rec(rows, { settings: { min_samples: 5, max_adjustment: .25 } }).recommendedPrice, 110);
});
test('malformed numeric evidence is excluded; output stays finite', () => {
  const rows = [...samples(5, { baselinePrice: NaN }), ...samples(5, { chosenPrice: Infinity }), null];
  const r = rec(rows, { lines: [{ ...line, baselinePrice: NaN, marginFloor: Infinity }], settings: { maxAdjustment: NaN } });
  assert.equal(r.sampleCount, 0);
  assert.equal(r.recommendedPrice, 0);
  assert.doesNotMatch(JSON.stringify(r), /NaN|Infinity/);
});
test('inputs are unchanged and enabled false disables both learning channels', () => {
  const input = { lines: [line], observations: samples(5, { measuredQuantity: 100, verifiedQuantity: 120, measurementReason: 'manual_measurement' }), settings: { enabled: false } };
  const before = structuredClone(input);
  const [r] = engine.recommend(input);
  assert.deepEqual(input, before);
  assert.equal(r.recommendedPrice, 100);
  assert.equal(r.measurement.factor, 1);
});
test('comparable quantity range and recorded GST registration must match', () => {
  assert.equal(rec(samples(10, { quantity: 201 })).sampleCount, 0);
  assert.equal(rec(samples(10, { quantity: 49 })).sampleCount, 0);
  assert.equal(rec(samples(5, { quantity: 50, baselinePrice: 50 })).sampleCount, 5);
  assert.equal(rec(samples(5, { context: { gstRegistered: false } }), { context: { gstRegistered: true } }).sampleCount, 0);
  assert.equal(rec(samples(5, { context: { gstRegistered: true } }), { context: { gstRegistered: true } }).sampleCount, 5);
});
test('valid large target floors are never capped below the passed target', () => {
  assert.ok(rec([], { lines: [{ ...line, marginFloor: 2e9 }] }).recommendedPrice >= 2e9);
  assert.ok(Number.isFinite(rec([], { lines: [{ ...line, baselinePrice: Number.MAX_VALUE, marginFloor: Number.MAX_VALUE }] }).recommendedPrice));
});
test('material baseline rate changes invalidate old corrections rather than compounding', () => {
  assert.equal(rec(samples(), { lines: [{ ...line, baselinePrice: 120 }] }).recommendedPrice, 120);
  assert.equal(rec(samples(5, { baselinePrice: 110 })).sampleCount, 5);
  assert.equal(rec(samples(5, { baselinePrice: 111 })).sampleCount, 0);
});

test('automatic feedback requires a real measured-service edit and preserves explicit reasons', () => {
  const edit={isManual:true,unit:'m²',chosenPrice:125,recommendedPrice:110};
  assert.equal(engine.reasonForPriceEdit(edit),'pricing_correction');
  assert.equal(engine.reasonForPriceEdit({...edit,unit:'m'}),'pricing_correction');
  for(const patch of [{isManual:false},{unit:'panes'},{chosenPrice:110},{chosenPrice:NaN},{recommendedPrice:Infinity},{verifiedQuantity:120}])
    assert.equal(engine.reasonForPriceEdit({...edit,...patch}),'');
  for(const reason of ['discount','extra_work','measurement_correction','unexplained','difficult_access'])
    assert.equal(engine.reasonForPriceEdit({...edit,reason}),reason);
  assert.equal(engine.reasonForPriceEdit({...edit,chosenPrice:0}),'pricing_correction','free service edits remain real observations');
});
test('automatic price feedback stays comparable by perimeter, area and storeys without changing old observations', () => {
  for(const unit of ['m²','m']) {
    const rows=samples(5,{unit,storeys:2,businessId:'a',reason:engine.reasonForPriceEdit({unit,isManual:true,chosenPrice:120,recommendedPrice:100})});
    const original=structuredClone(rows);
    const result=rec(rows,{businessId:'a',lines:[{...line,unit,storeys:2}]});
    assert.equal(result.recommendedPrice,110);
    assert.equal(rec(rows,{businessId:'a',lines:[{...line,unit,storeys:1}]}).sampleCount,0);
    assert.equal(rec(rows,{businessId:'b',lines:[{...line,unit,storeys:2}]}).sampleCount,0);
    assert.deepEqual(rows,original);
  }
  assert.equal(fs.readFileSync('extension/vendor/pricing-learning-engine.js','utf8'),fs.readFileSync('pricing-learning-engine.js','utf8'));
});
