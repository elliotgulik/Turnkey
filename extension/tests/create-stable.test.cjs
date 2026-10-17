const test=require('node:test'),assert=require('node:assert/strict');
test('a lost create response recovers the exact same business-scoped draft',async()=>{
 const {TurnKeyClient}=await import('../api/turnkey-api.js');
 const api=new TurnKeyClient({},null),calls=[];
 const row={id:'fixed',business_id:'B',lead_id:'C',amount:100,status:'draft',public_token:'generated'};
 api._rest=async (route,options)=>{calls.push({route,options});if(options)throw Error('response lost');return [row];};
 assert.equal((await api.createQuote('B',{id:'fixed',customerId:'C',amount:100})).public_token,'generated');
 assert.match(calls[1].route,/id=eq.fixed&business_id=eq.B/);
 assert.equal(JSON.parse(calls[0].options.body).id,'fixed');
});
test('retry never adopts a foreign or altered quote and never overwrites it',async()=>{
 const {TurnKeyClient}=await import('../api/turnkey-api.js');
 for(const changes of [{business_id:'other'},{amount:200}]){
  const api=new TurnKeyClient({},null);
  api._rest=async (_,options)=>{if(options)throw Error('conflict');return [{id:'fixed',business_id:'B',lead_id:'C',amount:100,status:'draft',...changes}];};
  await assert.rejects(api.createQuote('B',{id:'fixed',customerId:'C',amount:100}),/conflict/);
 }
});
