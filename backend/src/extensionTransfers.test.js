import test from 'node:test'
import assert from 'node:assert/strict'
import {installExtensionTransfers} from './extensionTransfers.js'
const job='11111111-1111-4111-8111-111111111111',external='22222222-2222-4222-8222-222222222222'
function setup({state='succeeded',foreign=false,connected=true,dbFailure=false}={}){
 const tables={jobs:[{id:job,business_id:foreign?'other':'mine'}],servicem8_connections:connected?[{business_id:'mine',generation:'g'}]:[],integration_tasks:[{business_id:'mine',kind:'handoff',payload:{jobId:job,generation:'g'},state}],external_object_mappings:[{business_id:'mine',connection_generation:'g',object_type:'job',local_id:job,external_uuid:external}]};
 const db={from(table){const filters=[];let single=false;const q={select(){return q},eq(k,v){filters.push(row=>k.includes('->>')?row[k.split('->>')[0]][k.split('->>')[1]]===v:row[k]===v);return q},order(){return q},limit(){return q},maybeSingle(){single=true;return q},then(resolve){if(dbFailure)return Promise.resolve({error:{code:'DB_UNAVAILABLE'}}).then(resolve);const data=tables[table].filter(r=>filters.every(f=>f(r)));return Promise.resolve({data:single?data[0]||null:data}).then(resolve)}};return q}};
 let handler;const auth=()=>{};
 installExtensionTransfers({get(path,middleware,fn){assert.equal(middleware,auth);handler=fn}},{db,requireBusiness:auth});
 return async()=>{const res={statusCode:200,set(){return res},status(n){res.statusCode=n;return res},json(body){res.body=body;return res}};await handler({params:{jobId:job},businessId:'mine'},res);return res}
}
test('completed transfer returns only the scoped ServiceM8 job link',async()=>{const r=await setup()();assert.equal(r.body.state,'transferred');assert.equal(r.body.openUrl,'https://go.servicem8.com/OpenJob/'+external);assert.equal(JSON.stringify(r.body).includes('generation'),false)});
test('failed latest transfer is not hidden by an older mapping',async()=>{const r=await setup({state:'failed'})();assert.equal(r.body.state,'failed');assert.equal(r.body.openUrl,undefined)});
test('foreign job cannot reveal another business transfer',async()=>{assert.equal((await setup({foreign:true})()).statusCode,404)});
test('disconnection is actionable and no mapping is disclosed',async()=>{const r=await setup({connected:false})();assert.equal(r.body.state,'not_connected');assert.equal(r.body.openUrl,undefined)});
test('database errors are real errors with no credential or raw query leakage',async()=>{const r=await setup({dbFailure:true})();assert.equal(r.statusCode,500);assert.equal(JSON.stringify(r.body).includes('DB_UNAVAILABLE'),false)});
