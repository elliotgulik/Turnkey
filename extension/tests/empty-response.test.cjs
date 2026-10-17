const test=require('node:test'),assert=require('node:assert/strict');
async function client(response){
 const {TurnKeyClient}=await import('../api/turnkey-api.js');
 global.fetch=async()=>response;
 return new TurnKeyClient({supabaseUrl:'https://fixture.invalid',supabaseAnonKey:'fixture'},{accessToken:'fixture',userId:'fixture',expiresAt:Date.now()+3600000});
}
test('PostgREST 201 with no body records activity successfully instead of throwing JSON error',async()=>{
 const api=await client(new Response('',{status:201}));
 assert.equal(await api.logActivity('B',{customerId:'C',jobId:'J',type:'note',summary:'Draft created'}),null);
});
test('204 minimal writes and normal JSON responses are accepted',async()=>{
 let api=await client(new Response(null,{status:204}));
 assert.equal(await api._rest('activity_log',{method:'POST'}),null);
 api=await client(new Response('[{"id":"C"}]',{status:200}));
 assert.deepEqual(await api._rest('customers'),[{id:'C'}]);
});
test('empty reads, malformed responses and real database errors remain failures',async()=>{
 let api=await client(new Response('',{status:200}));
 await assert.rejects(api._rest('customers'),/no data/);
 api=await client(new Response('<html>upstream failed</html>',{status:502}));
 await assert.rejects(api._rest('customers'),/HTTP 502/);
 api=await client(new Response('{"message":"permission denied"}',{status:403}));
 await assert.rejects(api._rest('customers'),/permission denied/);
});
