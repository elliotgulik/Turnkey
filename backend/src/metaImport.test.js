import test from 'node:test';
import assert from 'node:assert/strict';
import { importMetaBatch } from './metaImport.js';
import crypto from 'node:crypto';
const key = crypto.randomBytes(32);
const encrypt = value => {const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),b=Buffer.concat([c.update(value),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]).toString('base64');};
const decrypt = value => {const b=Buffer.from(value,'base64'),c=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return Buffer.concat([c.update(b.subarray(28)),c.final()]).toString();};
const lead = id => ({id,form_id:'10',created_time:'2026-09-01T00:00:00Z',field_data:[{name:'full_name',values:['Fixture Customer']},{name:'services',values:['House wash','Windows']}]});
const response = (data,next) => ({ok:true,json:async()=>({data,...(next?{paging:{next:'https://untrusted.example/?access_token=private',cursors:{after:next}}}:{})})});
function setup(){
 const saved=new Map(),calls=[];
 return {saved,calls,businessId:'A',pageId:'1',token:'private-token',encrypt,decrypt,now:()=>Date.parse('2026-10-20'),
  fetchEdge:async(id,edge,opts)=>{calls.push({id,edge,opts});return edge==='leadgen_forms'?response([{id:'10'},{id:'20'}]):id==='20'?response([]):!opts.after?response([lead('100')],'next-lead'):response([lead('101')]);},
  addLead:async payload=>{const deduped=saved.has(payload.external_id);saved.set(payload.external_id,payload);return {id:payload.external_id,deduped};}
 };
}
test('imports every lead/form page, preserves received date and skips webhook duplicates',async()=>{
 const d=setup();d.saved.set('100',{});let cursor,added=0,duplicates=0,forms=0;
 do{const r=await importMetaBatch({...d,cursor});cursor=r.cursor;added+=r.imported;duplicates+=r.duplicates;forms+=r.formsFound;}while(cursor);
 assert.equal(added,1);assert.equal(duplicates,1);assert.equal(forms,2);
 const p=d.saved.get('101');assert.equal(p.business_id,'A');assert.equal(p.source,'meta');assert.equal(p.historicalImport,true);assert.equal(p.submittedAt,Date.parse('2026-09-01'));assert.deepEqual(p.requestedServices,['House wash','Windows']);
 assert.deepEqual(d.calls.map(c=>[c.id,c.edge]),[['1','leadgen_forms'],['10','leads'],['10','leads'],['20','leads']]);
 assert.equal(d.calls[2].opts.after,'next-lead');
});
test('continuation cannot be forged or reused by another tenant or Page',async()=>{
 const d=setup(),first=await importMetaBatch(d);
 for(const changes of [{businessId:'B'},{pageId:'2'},{cursor:'forged'},{now:()=>Date.parse('2026-10-22')}]){
  await assert.rejects(importMetaBatch({...d,cursor:first.cursor,...changes}),e=>e.status===400);
 }
 assert.equal(d.calls.length,2);
});
test('database failure stops batch; safe replay imports remaining without duplicates',async()=>{
 const d=setup();d.fetchEdge=async(id,edge)=>edge==='leadgen_forms'?response([{id:'10'}]):response([lead('100'),lead('101')]);
 const store=d.addLead;let fail=true;d.addLead=async p=>{if(p.external_id==='101'&&fail)throw Error('db failed');return store(p);};
 await assert.rejects(importMetaBatch(d),/db failed/);assert.equal(d.saved.size,1);
 fail=false;const r=await importMetaBatch(d);assert.equal(r.imported,1);assert.equal(r.duplicates,1);assert.equal(r.done,true);
});
test('permission failure and foreign form responses never report a successful import',async()=>{
 const d=setup();d.fetchEdge=async()=>({ok:false,json:async()=>({error:{code:200,message:'private-token'}})});
 await assert.rejects(importMetaBatch(d),e=>e.status===403&&!e.message.includes('private-token'));
 d.fetchEdge=async(id,edge)=>edge==='leadgen_forms'?response([{id:'10'}]):response([{...lead('100'),form_id:'99'}]);
 await assert.rejects(importMetaBatch(d),/unexpected form/);assert.equal(d.saved.size,0);
});
test('empty form page with continuation is not mistaken for completed import',async()=>{
 const d=setup();d.fetchEdge=async()=>response([],'next-form-page');const r=await importMetaBatch(d);assert.equal(r.done,false);assert.ok(r.cursor);
});
