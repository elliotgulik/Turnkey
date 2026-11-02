const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const engine=require('../vendor/pricing-learning-engine.js');
function engines(){const c={window:{}};vm.createContext(c);for(const name of ['pricing-engine.js','cost-engine.js'])vm.runInContext(fs.readFileSync('extension/vendor/'+name,'utf8'),c);return c.window;}
const load=()=>import('../content/panel/quote-learning.js');
const lines=()=>[{lineKey:'a',svc:'driveway',qty:140},{lineKey:'b',svc:'driveway',qty:40},{lineKey:'c',svc:'deck',qty:20}];
test('largest remainder allocation reconciles awkward cents, zeros and equal weights',async()=>{
 const {allocatePrices}=await load();
 assert.deepEqual(allocatePrices(1,[1,1,1]),[.34,.33,.33]);
 assert.deepEqual(allocatePrices(.01,[0,0,0]),[.01,0,0]);
 for(const amount of [1.01,650.37,9999.99])for(const weights of [[1,100,7],[0,1,0],[0,0,0]])assert.equal(allocatePrices(amount,weights).reduce((a,b)=>a+Math.round(b*100),0),Math.round(amount*100));
 assert.throws(()=>allocatePrices(-1,[1]),/valid total/);
});
test('target margin floors include overheads and GST, learned prices cannot undercut them',async()=>{
 const {learningPricing}=await load(),{configureCosts}=await import('../content/panel/quote-pricing.js');const {TK_PRICING:p,TK_COST:c}=engines();
 configureCosts(c,{costInputs:{targetMargin:.82,wage:90,equipmentPerJob:40},overheads:{insurance:1200}});
 const model=learningPricing(p,c,lines(),{targetMargin:.82,access:'hard',travelKm:70,engine:{recommend:({lines})=>lines.map(l=>({...l,recommendedPrice:.01}))},learningState:{settings:{},observations:[]}});
 assert.ok(model.marginPct>=82);
 assert.ok(model.recommendations.every(l=>l.recommendedPrice>=l.marginFloor));
 assert.equal(model.lines.reduce((a,b)=>a+Math.round(b.fixedPrice*100),0),Math.round(model.total*100));
 assert.ok(model.recommendations.every(l=>l.baselinePrice===Math.max(l.configuredPrice,l.marginFloor)));
});
test('manual line prices survive context, margin, and learning recalculations; floor is advisory for final edits',async()=>{
 const {learningPricing}=await load(),{TK_PRICING:p,TK_COST:c}=engines();
 const rows=lines();rows[0].manualPrice=12.34;rows[1].manualPrice=56.78;
 for(const access of ['standard','hard'])for(const targetMargin of [.3,.8]) {
   const m=learningPricing(p,c,rows,{access,targetMargin,engine,learningState:{settings:{},observations:[]}});
   assert.equal(m.lines[0].fixedPrice,12.34);assert.equal(m.lines[1].fixedPrice,56.78);
   assert.ok(m.lines[0].fixedPrice<m.recommendations[0].marginFloor);
 }
 assert.equal(rows[0].manualPrice,12.34);
 const bad=rows.map(l=>({...l,manualPrice:NaN}));assert.throws(()=>learningPricing(p,c,bad),/valid final service price/);
});
test('real engine ignores discounts, blanks, extra work and measurement corrections when learning prices',async()=>{
 const {learningPricing}=await load(),{TK_PRICING:p,TK_COST:c}=engines();
 const rows=lines(),base=learningPricing(p,c,rows,{access:'standard'});
 const samples=reason=>Array.from({length:10},(_,i)=>({jobId:'job'+i,quoteKey:'quote'+i,svc:'driveway',unit:'m²',quantity:140,storeys:1,access:'standard',baselinePrice:base.recommendations[0].baselinePrice,chosenPrice:base.recommendations[0].baselinePrice*1.2,reason}));
 for(const reason of ['discount','','extra_work','measurement_correction']){
   const m=learningPricing(p,c,rows,{access:'standard',engine,learningState:{observations:samples(reason),settings:{}}});
   assert.equal(m.recommendations[0].sampleCount,0);assert.equal(m.recommendations[0].learnedAdjustment,0);
 }
 const learned=learningPricing(p,c,rows,{access:'standard',engine,learningState:{observations:samples('pricing_correction'),settings:{}}});
 assert.equal(learned.recommendations[0].sampleCount,10);assert.ok(learned.recommendations[0].learnedAdjustment>0);
 const access=learningPricing(p,c,rows,{access:'hard',engine,learningState:{observations:samples('difficult_access'),settings:{}}});
 assert.equal(access.recommendations[0].sampleCount,0,'access context must match exactly');
});
test('missing or failed engine leaves usable editable base pricing',async()=>{
 const {learningPricing}=await load(),{TK_PRICING:p,TK_COST:c}=engines(),rows=lines();rows[0].manualPrice=91.23;
 for(const options of [{},{engine:{recommend(){throw Error('unavailable')}},learningState:{}}]){
   const m=learningPricing(p,c,rows,options);assert.equal(m.lines[0].fixedPrice,91.23);assert.ok(m.total>0);
 }
});
test('observation retry follows durable job save, keeps exact context and never duplicates creation',async()=>{
 const {createQuoteDraft}=await import('../content/panel/quote-create.js');const {observationSubmission,learningPricing,observationLines}=await load();
 const {TK_PRICING:p,TK_COST:c}=engines(),rows=lines();rows[0]={...rows[0],qty:180,originalQuantity:140,verifiedQuantity:180,measurementReason:'site_measurement',reason:'measurement_correction'};
 const model=learningPricing(p,c,rows),snapshot={quoteKey:'intent',lines:observationLines(model,rows,p),context:{targetMargin:.55}};
 assert.equal(snapshot.lines[0].measuredQuantity,140);assert.equal(snapshot.lines[0].verifiedQuantity,180);
 let saved=false,creates=0,posts=0,bodies=[];
 const api={createQuote:async()=>({id:'Q',business_id:'B'}),createJob:async(b,payload)=>{creates++;assert.deepEqual(payload.details.quoteLearning,snapshot);saved=true;return {id:'J',business_id:b,quote_id:payload.quoteId}},logActivity:async()=>{},submitPricingLearning:async(b,body)=>{assert.ok(saved);assert.equal(b,'B');bodies.push(JSON.stringify(body));if(++posts===1)throw Error('Response lost');return {ok:true}}};
 const result=await createQuoteDraft(api,{}, {businessId:'B',payload:{isNewCustomer:false,customer:{id:'C'},lines:model.lines,total:model.total,quoteLearning:snapshot}});
 const submit=observationSubmission(api,'B',result.quote,result.job,snapshot);
 await assert.rejects(submit,/Response lost/);await Promise.all([submit(),submit()]);await submit();
 assert.equal(creates,1);assert.equal(posts,2);assert.equal(bodies[0],bodies[1]);assert.deepEqual(JSON.parse(bodies[1]).context,snapshot.context);
 let current=false;const changed=observationSubmission(api,'B',result.quote,result.job,snapshot,()=>current);
 await assert.rejects(changed,/account changed/);assert.equal(posts,2);
});

test('direct service edits learn automatically, distributed totals and generated prices do not',async()=>{
 const {learningPricing,observationLines}=await load(),{TK_PRICING:p,TK_COST:c}=engines();
 const rows=[{lineKey:'area',svc:'driveway',qty:140,manualPrice:700},{lineKey:'perimeter',svc:'housewash',qty:60,storeys:2,manualPrice:650}];
 const options={engine,learningState:{settings:{},observations:[]},businessId:'B'};
 const snapshot=r=>{const model=learningPricing(p,c,r,options);return {model,observations:observationLines(model,r,p)}};
 const {model,observations}=snapshot(rows);
 assert.deepEqual(observations.map(l=>l.reason),['pricing_correction','pricing_correction']);
 assert.deepEqual(observations.map(l=>[l.unit,l.quantity,l.storeys,l.chosenPrice]),[['m²',140,1,700],['m',60,2,650]]);
 assert.equal(snapshot(rows.map(l=>({...l,distributedPrice:true}))).observations[0].reason,'');
 assert.equal(snapshot(rows.map((l,i)=>({...l,manualPrice:model.recommendations[i].recommendedPrice}))).observations[0].reason,'');
 for(const reason of ['discount','extra_work','unexplained','difficult_access'])assert.equal(snapshot(rows.map(l=>({...l,reason}))).observations[0].reason,reason);
 assert.equal(model.lines[0].distributedPrice,undefined);
 // Revisiting changed service context must keep the actual edited price.
 assert.equal(snapshot(rows.map(l=>({...l,storeys:3}))).observations[1].chosenPrice,650);
});
