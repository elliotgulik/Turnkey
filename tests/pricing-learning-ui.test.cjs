const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
function fixture(){
  const calls=[],toasts=[];let persisted=false;
  const window={};const c={window,console,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout,WeakMap,Map,Date,Number,Math,Promise,document:{getElementById(id){return id==='qw-margin'?{value:'55'}:null;}},currentBusinessId:'biz-a',currentUserRole:'owner',activeLeadId:1,records:[],draftLines:[{svc:'driveway',qty:20,fixedPrice:150},{svc:'windows',qty:10,fixedPrice:75}],quoteAssumptions:{access:'standard'},quoteTravelInfo:{km:12},quoteTotalOverride:null,isWon:r=>r.stage==='won',toast:m=>toasts.push(m),confirmQuoteSend(){c.records[0].services=c.draftLines.map(l=>({...l}));c.records[0].total=225;},syncRecordToSupabase:async()=>{persisted=true;},renderEstimate(){},renderSvcLines(){},openQuoteModal(){},quoteTotal:()=>225};
  vm.createContext(c);for(const p of ['pricing-engine.js','cost-engine.js'])vm.runInContext(fs.readFileSync(p,'utf8'),c);c.TK_PRICING=window.TK_PRICING;c.TK_COST=window.TK_COST;c.SERVICES=c.TK_PRICING.SERVICES;c.COST_INPUTS=c.TK_COST.COST_INPUTS;
  window.TK_SALES_PLATFORM={request:async(path,opts)=>{calls.push({path,opts,persisted,business:c.currentBusinessId});return {settings:{enabled:true},observations:[]};}};
  c.records=[{id:1,stage:'new',jobId:'job-a'}];vm.runInContext(fs.readFileSync('pricing-learning-ui.js','utf8'),c);return {c,calls,toasts};
}
test('chosen line amounts sum exactly to the saved total and pricing metadata never edits measured outlines',()=>{const{c}=fixture();const data=c.window.TK_PRICE_LEARNING_UI.capture(c.records[0]);assert.deepEqual(Array.from(data.lines,l=>l.chosenPrice),[150,75]);assert.equal(data.lines.reduce((sum,l)=>sum+l.chosenPrice,0),225);assert.deepEqual(c.draftLines.map(l=>l.qty),[20,10]);assert.equal(c.records[0].total,undefined);assert.equal(data.context.gstRegistered,c.COST_INPUTS.gstRegistered);});
test('learning submission occurs only after a durable quote save and is idempotent within the session',async()=>{const{c,calls}=fixture();c.confirmQuoteSend();assert.equal(calls.length,0);assert(c.records[0].quoteLearning);await c.syncRecordToSupabase(c.records[0]);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/pricing-learning/observations');assert.equal(calls[0].persisted,true);await c.syncRecordToSupabase(c.records[0]);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,1);});
test('switching businesses clears pending learning rather than submitting another business records',async()=>{const{c,calls}=fixture();c.confirmQuoteSend();c.currentBusinessId='biz-b';await c.syncRecordToSupabase(c.records[0]);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,0);});
test('history failure leaves the durably saved quote intact with an actionable retry warning',async()=>{const{c,toasts}=fixture();c.window.TK_SALES_PLATFORM.request=async()=>{throw Error('History unavailable');};c.confirmQuoteSend();await c.syncRecordToSupabase(c.records[0]);await new Promise(resolve=>setImmediate(resolve));assert.equal(c.records[0].total,225);assert.match(toasts[0],/Quote saved.*Retry in Settings/);});
test('accepted quotes never capture a new learning decision',async()=>{const{c,calls}=fixture();c.records[0].stage='won';c.confirmQuoteSend();assert.equal(c.records[0].quoteLearning,undefined);await c.syncRecordToSupabase(c.records[0]);assert.equal(calls.length,0);});

test('CRM captures direct measured-service overrides automatically but excludes allocated totals and counts',()=>{
 const {c}=fixture();c.window.TK_PRICE_LEARNING=require('../pricing-learning-engine.js');
 let snapshot=c.window.TK_PRICE_LEARNING_UI.capture(c.records[0]);
 assert.equal(snapshot.lines[0].reason,'pricing_correction');
 assert.equal(snapshot.lines[1].reason,'','panes need an explicit reason');
 c.quoteTotalOverride=225;snapshot=c.window.TK_PRICE_LEARNING_UI.capture(c.records[0]);
 assert.equal(snapshot.lines[0].reason,'','a distributed total does not prove a service-price decision');
 c.quoteTotalOverride=null;delete c.draftLines[0].fixedPrice;
 assert.equal(c.window.TK_PRICE_LEARNING_UI.capture(c.records[0]).lines[0].reason,'');
});
test('failed history refresh clears old learned recommendations and falls back to configured settings',async()=>{
 const {c}=fixture();c.window.TK_PRICE_LEARNING=require('../pricing-learning-engine.js');
 const api=c.window.TK_PRICE_LEARNING_UI,entry=api.recommendations().lines[0];
 c.window.TK_SALES_PLATFORM.request=async()=>({settings:{},observations:Array.from({length:5},(_,i)=>({...entry,line:undefined,businessId:'biz-a',quoteKey:'q'+i,jobId:'j'+i,chosenPrice:entry.baselinePrice*1.2,reason:'pricing_correction'}))});
 await api.load(true);assert.equal(api.recommendations().results[0].sampleCount,5);
 c.window.TK_SALES_PLATFORM.request=async()=>{throw Error('offline')};await api.load(true);
 assert.equal(api.recommendations().results[0].sampleCount,0);
 assert.equal(api.recommendations().results[0].recommendedPrice,Math.round(entry.baselinePrice*100)/100);
});

test('acceptance between capture and retry prevents further learning writes',async()=>{
 const {c,calls}=fixture();c.confirmQuoteSend();c.records[0].quoteAcceptedAt='2026-11-02T00:00:00Z';
 await c.syncRecordToSupabase(c.records[0]);assert.equal(calls.length,0);
});
