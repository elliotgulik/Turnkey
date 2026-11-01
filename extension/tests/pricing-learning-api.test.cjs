const test=require('node:test'),assert=require('node:assert/strict');
let Client;test.before(async()=>{Client=(await import('../api/turnkey-api.js')).TurnKeyClient});
function client(){const c=new Client({supabaseUrl:'https://db.example',backendUrl:'https://backend.example'},{accessToken:'private-token',expiresAt:Date.now()+3600000});c.getRequiredProfile=async()=>({business_id:'business-a'});return c;}
test('learning reads and observations use the authenticated backend proxy with exact saved context',async()=>{
 const c=client(),requests=[];
 global.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,text:async()=>JSON.stringify(url.endsWith('/state')?{settings:{},observations:[],modelVersion:1}:{ok:true})}};
 assert.equal((await c.getPricingLearningState('business-a')).modelVersion,1);
 const body={quoteKey:'intent',jobId:'saved-job',lines:[{lineKey:'a',reason:''}],context:{gstRegistered:true}};
 await c.submitPricingLearning('business-a',body);
 assert.equal(requests[0].url,'https://backend.example/api/pricing-learning/state');
 assert.equal(requests[1].url,'https://backend.example/api/pricing-learning/observations');
 assert.equal(requests[1].options.method,'POST');assert.deepEqual(JSON.parse(requests[1].options.body),body);
 assert.equal(requests[1].options.headers.Authorization,'Bearer private-token');assert.ok(!requests[1].url.includes('private-token'));
});
test('learning never requests a foreign business or accepts a missing authenticated membership',async()=>{
 const c=client();global.fetch=async()=>assert.fail('must not fetch');
 await assert.rejects(c.getPricingLearningState('business-b'),/different business/);
 c.getRequiredProfile=async()=>{throw Error('No business profile')};
 await assert.rejects(c.submitPricingLearning('business-a',{quoteKey:'q',jobId:'j',lines:[]}),/business profile/);
});
test('learning preserves backend validation errors for visible, nonfatal save warnings',async()=>{
 const c=client();global.fetch=async()=>({ok:false,text:async()=>JSON.stringify({error:'Persist finalized snapshot first'})});
 await assert.rejects(c.submitPricingLearning('business-a',{quoteKey:'q',jobId:'j',lines:[]}),/finalized snapshot/);
});
test('optional learning deadline aborts a stalled request without blocking quote UI',async()=>{
 const c=client();let signal;
 c._salesBackend=async(path,business,options)=>{signal=options.signal;return new Promise(()=>{})};
 await assert.rejects(c._pricingLearningBackend('/api/pricing-learning/state','business-a',{},10),/timed out/);
 assert.equal(signal.aborted,true);
});
