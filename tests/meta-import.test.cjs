const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function fixture(reply){
 const notices=[],calls=[],progress={textContent:''};let polls=0;
 const ctx={window:{},currentBusinessId:'A',businessSessionVersion:1,document:{getElementById:()=>progress},toast:s=>notices.push(s),sb:{auth:{getSession:async()=>({data:{session:{access_token:'test'}}})}},backendUrl:()=>'/backend',pollBackendLeads:async()=>polls++,AbortSignal,fetch:async(url,o)=>{calls.push(JSON.parse(o.body));return {ok:true,json:async()=>reply(calls.length,ctx)};}};
 vm.runInNewContext(fs.readFileSync('meta-import.js','utf8'),ctx);
 return {ctx,notices,calls,progress,polls:()=>polls};
}
test('Meta importer follows continuation and polls durable intake after completion',async()=>{
 const f=fixture(n=>n===1?{imported:2,duplicates:1,formsFound:1,done:false,cursor:'opaque'}:{imported:1,duplicates:0,formsFound:0,done:true,cursor:null});
 await f.ctx.window.TK_META_IMPORT.start();assert.deepEqual(f.calls,[{cursor:null},{cursor:'opaque'}]);assert.equal(f.polls(),1);assert.match(f.progress.textContent,/3 new enquiries saved, 1 already saved/);
});
test('switching business stops import and suppresses previous-business feedback',async()=>{
 const f=fixture((n,c)=>{c.currentBusinessId='B';return {imported:1,done:false,cursor:'opaque'};});
 await f.ctx.window.TK_META_IMPORT.start();assert.equal(f.calls.length,1);assert.equal(f.polls(),0);assert.equal(f.notices.length,0);
});
test('historical imports do not trigger the original intake customer email',()=>{
 const s=fs.readFileSync('index.html','utf8');
 assert.match(s,/if\(!payload\.historicalImport\)sendLifecycleEmail\(rec,'new_lead'\)/);
 assert.match(s,/if\(!payload\.historicalImport\)notifyOwner\('new_lead'/);
 assert.match(s,/if\(sid&&!payload\.external_id&&records\.some/);
});
