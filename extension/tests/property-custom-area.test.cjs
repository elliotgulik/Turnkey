const test=require('node:test'),assert=require('node:assert/strict');

test('property anchors beat camera centres and only explicit property metadata qualifies',async()=>{
 const {resolvePropertyLocation:resolve}=await import('../content/panel/customer-context.js');
 const property={lat:-36.81,lng:174.71,address:'12 Test Road'},camera={lat:-36,lng:174};
 assert.deepEqual(resolve({address:property.address,job:{details:{propertyLocation:property,mapCenter:camera}}},camera),{position:{lat:property.lat,lng:property.lng},source:'property'});
 assert.deepEqual(resolve({job:{details:{mapCenter:property}}},camera),{position:camera,source:'camera'});
 assert.equal(resolve({propertyLocation:{lat:NaN,lng:174}}),null);
 assert.equal(resolve({address:'Other Road',propertyLocation:property}),null);
 assert.deepEqual(resolve({propertyLocation:{lat:0,lng:0}},camera),{position:{lat:0,lng:0},source:'property'});
});
test('custom outlines use fixed pricing independent of measured area and editable units',async()=>{
 const {customMeasurementLine}=await import('../content/panel/measurements.js');
 const {normalizeCustomLine}=await import('../content/panel/quote-pricing.js');
 const m={id:'outline',category:'custom',size:321,unit:'m²',categoryLabel:'Custom area'};
 const draft=customMeasurementLine(m);
 assert.equal(draft.qty,1);assert.equal(draft.unit,'item');assert.equal(draft.unitPrice,null);
 const saved=normalizeCustomLine({...draft,label:'  Special work ',unit:' day ',unitPrice:187.65});
 assert.equal(saved.fixedPrice,187.65);assert.equal(saved.unit,'day');assert.equal(saved.measurementId,'outline');
 assert.equal(customMeasurementLine(m,saved).unitPrice,187.65);
 assert.throws(()=>normalizeCustomLine({...saved,unit:' '}),/Choose item/);
 assert.throws(()=>normalizeCustomLine({...saved,unit:'visit'}),/Choose item/);
});
test('bridge preserves validated property geocode as additive result metadata',async()=>{
 const bridge=require('../content/bridge/measure-bridge.js');
 const msg={requestId:'r',kind:'area',category:'custom',points:[{lat:0,lng:0},{lat:0,lng:.001},{lat:.001,lng:0}],propertyLocation:{lat:0,lng:0,address:'Zero'}};
 assert.equal(bridge.validatePayloadShape(msg),null);
 const geometry=await import('../geometry.js');
 assert.deepEqual((await bridge.computeResult(geometry,msg)).propertyLocation,msg.propertyLocation);
 assert.match(bridge.validatePayloadShape({...msg,propertyLocation:{lat:Infinity,lng:0}}),/Invalid property/);
});
