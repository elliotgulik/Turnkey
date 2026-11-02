import test from 'node:test';
import assert from 'node:assert/strict';
import {createMetaLeadSync} from './metaLeadSync.js';
const time=Date.parse('2026-11-03T00:00:00Z');
function setup({fail=false,duplicate=false}={}){
 const source={id:'source-a',business_id:'A',external_id:'123',token_enc:'encrypted'};
 const job={cursor:null,last_success_at:null,cycle_started_at:new Date(time).toISOString(),imported_count:0};
 const saved=[],alerts=[],calls=[],warnings=[];let claim=true;
 const db={rpc:async(name,args)=>{calls.push({name,args});return {data:claim?[{...job}]:[],error:null};},from(table){
  let patch,filters={};return {select(){return this;},eq(k,v){filters[k]=v;return this;},order(){return this;},range:async()=>({data:[source]}),
   update(value){patch=value;return this;},then(resolve){Object.assign(job,patch);resolve({data:null,error:null});}};
 }};
 const deps={db,now:()=>time,decrypt:()=>JSON.stringify({version:1,retrievalToken:'user-token',pageToken:'page-token'}),encrypt:x=>x,
  addLead:async p=>{saved.push(p);return {id:'lead',deduped:duplicate};},notify:async p=>alerts.push(p),log:{warn:(...x)=>warnings.push(x)},
  batch:async opts=>{calls.push(opts);if(fail)throw Object.assign(Error('private-provider-error'),{status:503});await opts.addLead({business_id:opts.businessId,submittedAt:time,customer:{name:'Fixture'}});return {cursor:'next',done:false,imported:duplicate?0:1};}};
 return {deps,job,saved,alerts,calls,warnings,setClaim:value=>{claim=value;}};
}
test('background imports use saved tenant/Page credentials, persist continuation and notify once',async()=>{
 const d=setup();await createMetaLeadSync(d.deps).tick();
 const call=d.calls.find(x=>x.businessId);assert.equal(call.businessId,'A');assert.equal(call.pageId,'123');assert.equal(call.token,'page-token');assert.equal(call.historical,false);assert.equal(call.since,(time-3*86400000)/1000);
 assert.equal(d.job.cursor,'next');assert.equal(d.job.lease_token,null);assert.equal(d.saved.length,1);assert.equal(d.alerts.length,1);
 const restarted=createMetaLeadSync(d.deps);await restarted.tick();assert.equal(d.calls.filter(x=>x.businessId).at(-1).cursor,'next');
});
test('another instance holding the database lease prevents duplicate work',async()=>{
 const d=setup();d.setClaim(false);await createMetaLeadSync(d.deps).tick();assert.equal(d.saved.length,0);assert.equal(d.calls.filter(x=>x.businessId).length,0);
});
test('replayed leads do not notify twice',async()=>{
 const d=setup({duplicate:true});await createMetaLeadSync(d.deps).tick();assert.equal(d.alerts.length,0);
});
test('failures retain checkpoint, schedule retry and never persist provider secrets',async()=>{
 const d=setup({fail:true});d.job.cursor='checkpoint';await createMetaLeadSync(d.deps).tick();assert.equal(d.job.cursor,'checkpoint');assert.equal(Date.parse(d.job.next_run_at),time+60000);assert.doesNotMatch(d.job.last_error,/private-provider-error/);assert.equal(d.job.last_success_at,null);
});
test('completed cycles advance watermark only after all batches were stored',async()=>{
 const d=setup();d.deps.batch=async()=>({cursor:null,done:true,imported:0});await createMetaLeadSync(d.deps).tick();assert.equal(d.job.last_success_at,new Date(time).toISOString());assert.equal(d.job.cycle_started_at,null);
});
