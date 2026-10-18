const test=require('node:test'),assert=require('node:assert/strict');
let Client;test.before(async()=>{Client=(await import('../api/turnkey-api.js')).TurnKeyClient});
const job='11111111-1111-4111-8111-111111111111';
function client(){const c=new Client({supabaseUrl:'https://db.example',backendUrl:'https://backend.example'},{accessToken:'session-token',expiresAt:Date.now()+3600000});c.getProfile=async()=>({business_id:'business-a'});return c}
test('saved draft handoff uses authenticated quote mode and waits for durable queue confirmation',async()=>{
 const c=client();let request;
 global.fetch=async(url,options)=>{request={url,options};return {ok:true,text:async()=>JSON.stringify({queued:true})}};
 assert.deepEqual(await c.sendQuoteToServiceM8('business-a',job),{queued:true});
 assert.equal(request.url,'https://backend.example/api/sales/servicem8/handoff');
 assert.deepEqual(JSON.parse(request.options.body),{jobId:job,mode:'quote'});
 assert.equal(request.options.headers.Authorization,'Bearer session-token');
});
test('wrong-business session never queues an existing quote',async()=>{
 const c=client();global.fetch=async()=>{assert.fail('must not request backend')};
 await assert.rejects(c.sendQuoteToServiceM8('business-b',job),/different business/);
});
test('empty/malformed and failed queue responses do not claim success',async()=>{
 const c=client();
 for(const value of ['', '<html>']){global.fetch=async()=>({ok:true,text:async()=>value});await assert.rejects(c.sendQuoteToServiceM8('business-a',job),/not confirm|not read/)}
 global.fetch=async()=>({ok:false,text:async()=>JSON.stringify({error:'Connect ServiceM8 first.'})});
 await assert.rejects(c.sendQuoteToServiceM8('business-a',job),/Connect ServiceM8/);
});
test('retry reuses the saved job reference rather than creating another quote or job',async()=>{
 const c=client();const bodies=[];
 global.fetch=async(url,options)=>{bodies.push(options.body);if(bodies.length===1)throw Error('Lost response');return {ok:true,text:async()=>'{"queued":true}'}};
 await assert.rejects(c.sendQuoteToServiceM8('business-a',job),/Lost response/);
 await c.sendQuoteToServiceM8('business-a',job);assert.equal(bodies[0],bodies[1]);
});
test('progress reads the per-job authenticated endpoint',async()=>{
 const c=client();let url;
 global.fetch=async(u)=>{url=u;return {ok:true,text:async()=>'{"state":"failed","message":"Needs attention"}'}};
 assert.equal((await c.serviceM8TransferStatus('business-a',job)).state,'failed');
 assert.equal(url,'https://backend.example/api/extension/servicem8/jobs/'+job);
});
