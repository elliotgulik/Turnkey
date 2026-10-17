const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const square=[{lat:-36.8,lng:174.7,altitude:20},{lat:-36.8,lng:174.7001,altitude:20},{lat:-36.8001,lng:174.7001,altitude:22},{lat:-36.8001,lng:174.7,altitude:22}];
test('insert between corners, move without stale elevation, delete and undo edits',async()=>{
 const {editOutline,createOutlineHistory,displayAltitude}=await import('../../measurement-editor.js');
 const h=createOutlineHistory();h.commit(square);
 let next=editOutline(h.points,{action:'insert',index:0,point:{lat:-36.79999,lng:174.70005,altitude:25},view:'3d'});h.commit(next);
 assert.equal(next.length,5);assert.equal(next[1].altitude,25);assert.deepEqual(next[2],square[1]);
 next=editOutline(next,{action:'move',index:1,point:{lat:-36.79998,lng:174.70005,altitude:99},view:'2d'});h.commit(next);
 assert.equal(next[1].altitude,undefined);
 h.commit(editOutline(next,{action:'delete',index:1}));assert.equal(h.points.length,4);assert.equal(h.undo().length,5);assert.equal(h.undo()[1].altitude,25);
 const enums={ABSOLUTE:'sdk-absolute',CLAMP_TO_GROUND:'sdk-ground'};
 assert.equal(displayAltitude(square,'ground',enums).altitudeMode,'sdk-ground');
 assert.equal(displayAltitude(square,'ground',enums).coordinates[0].altitude,undefined);
 assert.equal(displayAltitude(square,'surface',enums).altitudeMode,'sdk-absolute');
 assert.equal(displayAltitude(next,'surface',enums).altitudeMode,'sdk-ground');
});
function engines(){const c={window:{}};vm.createContext(c);for(const name of ['pricing-engine.js','cost-engine.js'])vm.runInContext(fs.readFileSync(name,'utf8'),c);return c.window;}
test('recommended price and edited total use the existing cost engine with exact line allocation',async()=>{
 const {configureCosts,instantPricing}=await import('../content/panel/quote-pricing.js'),e=engines(),cost=e.TK_COST;
 configureCosts(cost,{costInputs:{wage:40,targetMargin:0.6},overheads:{insurance:400}});
 const lines=[{svc:'deck',qty:80},{svc:'driveway',qty:50}],bd=cost.costBreakdown(lines,{km:20},{targetMargin:0.6});
 const rec=instantPricing(e.TK_PRICING,cost,lines,{targetMargin:0.6,travelKm:20});assert.equal(rec.total,bd.recommended);assert.ok(rec.marginPct>=60);
 const chosen=instantPricing(e.TK_PRICING,cost,lines,{price:500,targetMargin:0.7,estimatedAt:'stable'});
 assert.equal(chosen.total,500);assert.equal(e.TK_PRICING.quoteTotal(chosen.lines,{}),500);assert.equal(chosen.snapshot.estimatedAt,'stable');
 assert.ok(Math.abs(chosen.exGst+chosen.gst-500)<0.00001);assert.equal(cost.COST_INPUTS.targetMargin,0.6);
 configureCosts(cost,{});assert.equal(cost.COST_INPUTS.wage,32);assert.equal(cost.OVERHEADS.insurance.perMonth,0);
 configureCosts(cost,{costInputs:{gstRegistered:false}});assert.equal(instantPricing(e.TK_PRICING,cost,lines,{price:500}).gst,0);
 assert.throws(()=>instantPricing(e.TK_PRICING,cost,lines,{price:-1}),/valid final price/);
 assert.equal(fs.readFileSync('extension/vendor/cost-engine.js','utf8'),fs.readFileSync('cost-engine.js','utf8'));
});
