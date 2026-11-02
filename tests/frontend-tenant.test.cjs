const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
function section(from,to){const start=html.indexOf(from);assert.ok(start>=0);return html.slice(start,html.indexOf(to,start));}
function context(extra={}){
 const storage=new Map();
 return vm.createContext({currentBusinessId:'A',businessSessionVersion:1,businessStateReady:true,records:[],goals:[],seq:1,goalSeq:1,followSeq:1,docTemplate:{},TK_COST:{chemicalConfig:()=>({}),applyChemicalConfig(){}},CHEMICALS:{},SERVICES:{},COST_INPUTS:{},recordBusinesses:new WeakMap(),localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},scheduleSupabaseSync(){},render(){},renderAll(){},toast(){},console,...extra});
}
test('legacy state is preserved but never assigned; business caches stay isolated',()=>{
 const ctx=context();
 vm.runInContext(section("const STORE_KEY='turnkey-app-v1';",'/* ===== Supabase: auth'),ctx);
 vm.runInContext(section('function loadState(){','function exportData(){'),ctx);
 const legacy=JSON.stringify({records:[{name:'Legacy customer'}],goals:[{label:'Legacy goal'}]});
 ctx.localStorage.setItem('turnkey-app-v1',legacy);
 assert.equal(ctx.loadState(),false);
 assert.equal(ctx.records.length,0);assert.equal(ctx.goals.length,0);
 assert.equal(ctx.localStorage.getItem('turnkey-app-v1:legacy-unassigned'),legacy);
 ctx.records=[{name:'A customer'}];ctx.goals=[{label:'A goal'}];ctx.saveState();
 ctx.currentBusinessId='B';ctx.records=[];ctx.goals=[];
 assert.equal(ctx.loadState(),false);assert.equal(ctx.records.length,0);assert.equal(ctx.goals.length,0);
 ctx.saveState();ctx.currentBusinessId='A';assert.equal(ctx.loadState(),true);
 assert.equal(ctx.records[0].name,'A customer');assert.equal(ctx.goals[0].label,'A goal');
 assert.equal(ctx.recordBusinesses.get(ctx.records[0]),'A');
 ctx.localStorage.setItem('turnkey-app-v1:business:B',ctx.localStorage.getItem('turnkey-app-v1:business:A'));
 ctx.currentBusinessId='B';ctx.records=[];ctx.goals=[];
 assert.equal(ctx.loadState(),false);assert.equal(ctx.records.length,0);
});
test('late database response cannot replace the next business records',async()=>{
 const pending=[];const filters=[];
 const ctx=context({sb:{from(table){const q={select(){return q},eq(k,v){filters.push([table,k,v]);return q;},neq(){return q;},order(){return q;},range(){return new Promise(resolve=>pending.push(resolve));}};return q;}},newRecord(){throw Error('stale rows must never be materialized');}});
 vm.runInContext(section('async function loadFromSupabase(){','function scheduleSupabaseSync(){'),ctx);
 const load=ctx.loadFromSupabase();
 ctx.currentBusinessId='B';ctx.businessSessionVersion++;ctx.records=[{name:'B customer'}];
 pending.forEach(resolve=>resolve({data:[]}));
 assert.equal(await load,false);assert.equal(ctx.records[0].name,'B customer');
 assert.ok(filters.every(([,key,value])=>key==='business_id'&&value==='A'));
});
test('switch during a save prevents subsequent writes and rejects old records',async()=>{
 let release;const requests=[];
 const ctx=context({sb:{from(table){requests.push(table);const q={update(){return q},eq(){return q},then(resolve){return new Promise(r=>release=r).then(resolve);}};return q;}}});
 vm.runInContext(section('const recordSaveQueue = new WeakMap();','/* ===== Supabase Storage:'),ctx);
 const record={name:'Customer A',customerId:'customer-A',stage:'new',total:0};ctx.recordBusinesses.set(record,'A');
 const save=ctx.syncRecordToSupabase(record);
 await new Promise(resolve=>setImmediate(resolve));ctx.currentBusinessId='B';ctx.businessSessionVersion++;release({});
 await assert.rejects(save,/Business session changed/);assert.deepEqual(requests,['customers']);
 await assert.rejects(ctx.syncRecordToSupabase(record),/Business session changed/);assert.deepEqual(requests,['customers']);
});
test('startup waits for database load and no longer loads an unscoped cache',()=>{
 const auth=section('async function handleAuthedSession(session){','// Real "last active');
 assert.ok(auth.indexOf('await loadFromSupabase()')<auth.indexOf('showApp()'));
 assert.ok(!html.includes('if(!goals.length)loadState()'));
 for(const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(script[1].trim())new vm.Script(script[1]);
});
test('auth clears the old business before waiting and never reveals an obsolete session',async()=>{
 let finishLoad;let shown=0;let hidden=0;
 const ctx=context({records:[{name:'A customer'}],goals:[{label:'A goal'}],currentUserId:'user-A',supabaseSyncTimer:null,clearTimeout(){},showWorkspaceLoading(){hidden++},showAuth(){hidden++},showApp(){shown++},resolveProfile:async()=>({businessId:'B',role:'owner'}),window:{TK_SALES_PLATFORM:{reset(){}}},loadState(){return false},applyRoleVisibility(){},loadFromSupabase:()=>new Promise(resolve=>finishLoad=resolve)});
 vm.runInContext(section('async function handleAuthedSession(session){','// Real "last active'),ctx);
 const auth=ctx.handleAuthedSession({user:{id:'user-B'}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ctx.currentBusinessId,'B');assert.equal(ctx.records.length,0);assert.equal(ctx.goals.length,0);
 assert.equal(hidden,1);assert.equal(shown,0);
 ctx.businessSessionVersion++;ctx.currentBusinessId='C';finishLoad(true);await auth;
 assert.equal(shown,0);assert.equal(ctx.businessStateReady,false);
});

 test('customer pagination preserves a job identity beyond the first thousand profiles without autosaving hydration',async()=>{
 const customers=Array.from({length:1001},(_,i)=>({id:'c'+i,name:'Customer '+i})),calls=[];let writes=0;
 const ctx=context({sb:{from(table){const q={select(){return q},eq(){return q},neq(){return q},order(){return q},range(start,end){calls.push([table,start,end]);return Promise.resolve({data:table==='customers'?customers.slice(start,end+1):table==='jobs'?[{id:'job',customer_id:'c1000',status:'new',details:{}}]:[]});}};return q;}},newRecord:d=>({...d}),render(){if(ctx.businessStateReady)writes++;},renderAll(){if(ctx.businessStateReady)writes++;}});
 vm.runInContext(section('async function loadFromSupabase(){','function scheduleSupabaseSync(){'),ctx);
 assert.equal(await ctx.loadFromSupabase(),true);assert.equal(ctx.records[0].name,'Customer 1000');assert.equal(ctx.records[0].customerId,'c1000');assert.equal(writes,0);assert.equal(ctx.businessStateReady,true);assert.ok(calls.some(([table,start])=>table==='customers'&&start===1000));
 });
 test('missing customer never becomes a new blank profile',async()=>{
 const ctx=context({sb:{from(table){const q={select(){return q},eq(){return q},neq(){return q},order(){return q},range(){return Promise.resolve({data:table==='jobs'?[{id:'job',customer_id:'original-customer',details:{}}]:[]});}};return q;}},newRecord:d=>({...d})});
 vm.runInContext(section('async function loadFromSupabase(){','function scheduleSupabaseSync(){'),ctx);
 await ctx.loadFromSupabase();assert.equal(ctx.records[0].customerId,'original-customer');assert.equal(ctx.records[0]._customerMissing,true);
 });

test('blank historical job snapshots cannot overwrite recovered customer fields; archived tests stay hidden',async()=>{
 const ctx=context({sb:{from(table){const q={select(){return q},eq(){return q},neq(){return q},order(){return q},range(){return Promise.resolve({data:table==='customers'?[{id:'c1',name:'Recovered Name',email:'recovered@example.test',phone:'0210000000',address:'7 Example Road',source:'Wix'}]:table==='jobs'?[{id:'j1',customer_id:'c1',details:{name:'',email:'',phone:'',address:'',source:''}},{id:'test',customer_id:'c1',details:{testLeadArchivedAt:123}}]:[]});}};return q;}},newRecord:d=>({...d})});
 vm.runInContext(section('async function loadFromSupabase(){','function scheduleSupabaseSync(){'),ctx);
 assert.equal(await ctx.loadFromSupabase(),true);assert.equal(ctx.records.length,1);assert.equal(ctx.records[0].name,'Recovered Name');assert.equal(ctx.records[0].email,'recovered@example.test');assert.equal(ctx.records[0].source,'Wix');
});

test('hydration coalesces a repeated submission but preserves separate quoted jobs for one customer',async()=>{
 const identity=require('../lead-identity.js');
 const rows=[{id:'blank-copy',customer_id:'c',status:'new',details:{externalSource:'wix',externalId:'submission',total:0}},
 {id:'quoted-job',customer_id:'c',quote_id:'quote-1',status:'quoted',details:{externalSource:'wix',externalId:'submission',total:465}},
 {id:'separate-job',customer_id:'c',quote_id:'quote-2',status:'quoted',details:{externalSource:'wix',externalId:'different-submission',total:300}}];
 const ctx=context({TK_LEAD_IDENTITY:identity,sb:{from(table){const q={select(){return q},eq(){return q},neq(){return q},order(){return q},range(){return Promise.resolve({data:table==='customers'?[{id:'c',name:'Same Customer'}]:table==='jobs'?rows:[]});}};return q;}},newRecord:d=>({...d})});
 vm.runInContext(section('async function loadFromSupabase(){','function scheduleSupabaseSync(){'),ctx);
 assert.equal(await ctx.loadFromSupabase(),true);assert.equal(ctx.records.length,2);
 assert.deepEqual(Array.from(ctx.records,r=>r.jobId),['quoted-job','separate-job']);assert.equal(ctx.records[0].total,465);
});

test('intake returns its actual record, prevents redelivery and preserves same-time different submissions',()=>{
 const identity=require('../lead-identity.js');
 const ctx=context({window:{TK_LEAD_IDENTITY:identity},document:{getElementById(){return null;}},newRecord:d=>({id:7,...d}),
 normalizeReqSvc:v=>v,switchView(){},ensureRecordSynced:async()=>{},logActivity(){},sendLifecycleEmail(){},notifyOwner(){}});
 vm.runInContext(section('function ingestQuoteRequest(payload){','/* ===== Upload photos'),ctx);
 const payload={business_id:'A',external_id:'first',source:'wix',submittedAt:'2026-11-03T01:00:00Z',historicalImport:true,customer:{name:'Same Customer'},requestedServices:['House wash']};
 const a=ctx.ingestQuoteRequest(payload),again=ctx.ingestQuoteRequest({...payload});
 assert.strictEqual(a,again);assert.equal(ctx.records.length,1);assert.equal(a.externalId,'first');
 const b=ctx.ingestQuoteRequest({...payload,external_id:'second'});
 assert.notStrictEqual(a,b);assert.equal(ctx.records.length,2);assert.equal(a.id,b.id,'UI ids cannot be intake identity');
 assert.equal(ctx.ingestQuoteRequest({...payload,business_id:'B'}),undefined);
});
