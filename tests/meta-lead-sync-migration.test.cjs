const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
test('Meta sync leases persist progress, exclude concurrent claims and remain backend-only',async()=>{
 const db=new PGlite(),id='00000000-0000-4000-8000-000000000001',lease='00000000-0000-4000-8000-000000000002';
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table lead_sources(id uuid primary key,business_id text,provider text,external_id text,updated_at timestamptz default now());
 grant usage on schema public to service_role;grant all on lead_sources to service_role;
 insert into lead_sources(id,business_id,provider,external_id) values('${id}','A','meta','123');`);
 const sql=fs.readFileSync('supabase/migrations/20261102223004_meta_lead_background_sync.sql','utf8');await db.exec(sql);await db.exec(sql);
 await db.exec('set role service_role');
 const claim=()=>db.query('select * from claim_meta_lead_sync($1,$2)',[id,lease]);
 assert.equal((await claim()).rows.length,1);assert.equal((await claim()).rows.length,0);
 await db.query("update meta_lead_sync set cursor='checkpoint',lease_until=now()-interval '1 second'");assert.equal((await claim()).rows[0].cursor,'checkpoint');
 await db.exec("update meta_lead_sync set lease_until=null;update lead_sources set external_id='456',updated_at=now()+interval '1 second'");assert.equal((await claim()).rows[0].cursor,null);
 await db.exec('reset role');
 assert.equal((await db.query("select has_function_privilege('authenticated','claim_meta_lead_sync(uuid,uuid)','execute') as allowed")).rows[0].allowed,false);
 assert.equal((await db.query("select has_table_privilege('anon','meta_lead_sync','select') as allowed")).rows[0].allowed,false);
 }finally{await db.close();}
});
