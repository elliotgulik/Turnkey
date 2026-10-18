const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
const {btree_gist}=require('@electric-sql/pglite/contrib/btree_gist');
const U='11111111-1111-4111-8111-111111111111', J='22222222-2222-4222-8222-222222222222', A='33333333-3333-4333-8333-333333333333';
let db;
test.before(async()=>{
 db=new PGlite({extensions:{btree_gist}});
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table businesses(id text primary key);create table users(id uuid primary key,business_id text,role text);create table jobs(id uuid primary key,business_id text);
 insert into businesses values ('a'),('b');insert into users values ('${U}','a','owner');insert into jobs values ('${J}','a');`);
 const sql=fs.readFileSync(require('node:path').join(__dirname,'../supabase/migrations/20261018031355_job_work_records.sql'),'utf8');
 assert.ok(sql.length>100,'Migration must contain the implementation');
 await db.exec(sql);await db.exec(sql); // rerunning must preserve data and definitions
 await db.exec(fs.readFileSync(require('node:path').join(__dirname,'../supabase/migrations/20261018033149_job_work_extension_schema.sql'),'utf8'));
 await db.query('insert into equipment_assets(id,business_id,name,service_interval_hours) values ($1,$2,$3,$4)',[A,'a','Pump',10]);
});
test.after(async()=>{await db?.close()});
const request=(n)=>`44444444-4444-4444-8444-${String(n).padStart(12,'0')}`;
function submit(n,start,end,equipment=[],business='a',job=J){return db.query('select * from record_job_work($1,$2,$3,$4,$5,$6,$7,$8)',[business,job,U,start,end,'',request(n),JSON.stringify(equipment)])}
test('atomic work log, adjacent windows, idempotency and tenant checks',async()=>{
 const first=await submit(1,'2026-10-18T00:00Z','2026-10-18T01:00Z',[{asset_id:A,hours:0.75}]);
 assert.equal(first.rows[0].deduped,false);
 const retry=await submit(1,'2026-10-18T00:00Z','2026-10-18T01:00Z',[{asset_id:A,hours:0.75}]);
 assert.equal(retry.rows[0].deduped,true);
 assert.equal(retry.rows[0].log_id,first.rows[0].log_id);
 await assert.rejects(submit(1,'2026-10-18T00:00Z','2026-10-18T01:00Z',[{asset_id:A,hours:0.5}]),/different work details/i);
 await submit(2,'2026-10-18T01:00Z','2026-10-18T02:00Z',[{asset_id:A,hours:0.5}]);
 await assert.rejects(submit(3,'2026-10-18T00:30Z','2026-10-18T01:30Z'),/conflict|overlap/i);
 await assert.rejects(submit(4,'2026-10-18T03:00Z','2026-10-18T04:00Z',[],'b'),/business/i);
 await assert.rejects(submit(5,'2026-10-18T03:00Z','2026-10-18T04:00Z',[{asset_id:A,hours:2}]),/hours|runtime|duration/i);
 const totals=await db.query('select sum(hours)::float as hours from equipment_usage');
 assert.equal(totals.rows[0].hours,1.25);
 const count=await db.query('select count(*)::int as n from job_work_logs');assert.equal(count.rows[0].n,2);
});
test('service event uses current meter and private tables/RPC stay restricted',async()=>{
 const result=await db.query('select * from mark_equipment_serviced($1,$2,$3,$4)',['a',A,U,'Oil change']);
 assert.equal(Number(result.rows[0].meter_hours),1.25);
 const privileges=await db.query(`select has_table_privilege('authenticated','job_work_logs','select') as client_read, has_function_privilege('anon','record_job_work(text,uuid,uuid,timestamptz,timestamptz,text,uuid,jsonb)','execute') as client_write`);
 assert.deepEqual(privileges.rows[0],{client_read:false,client_write:false});
});
