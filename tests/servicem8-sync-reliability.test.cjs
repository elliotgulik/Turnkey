const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
test('ServiceM8 authority preserves history, restores active work, fences tenants and stale browser saves',async()=>{
 const db=new PGlite();const id='00000000-0000-4000-8000-000000000001';
 const sql=fs.readFileSync('supabase/migrations/20261031031203_servicem8_sync_reliability.sql','utf8');
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table jobs(id uuid primary key,business_id text,status text,scheduled_date date,details jsonb,updated_at timestamptz default now());
 create table integration_tasks(kind text constraint integration_tasks_kind_check check(kind in ('handoff','webhook','refresh_job','reminder')));
 grant usage on schema public to service_role,authenticated;grant all on jobs to service_role,authenticated;
 insert into jobs values('${id}','a','quoted','2026-10-10','{"total":575,"services":["house"],"salesNotes":"original"}',now());`);
 await db.exec(sql);await db.exec(sql);
 const sync=async(status,booking=null,missing=false)=>{
   await db.exec('set role service_role');
   try{await db.query('select sync_servicem8_job_state($1,$2,$3,$4,$5)',['a',id,status,booking?JSON.stringify(booking):null,missing]);}finally{await db.exec('reset role');}
 };
 await sync('Completed');
 let row=(await db.query('select * from jobs')).rows[0];
 assert.equal(row.status,'completed');assert.equal(new Date(row.scheduled_date).toISOString().slice(0,10),'2026-10-10');assert.equal(row.details.total,575);
 await db.exec('set role authenticated');
 await db.query("update jobs set status='quoted',scheduled_date=null,details=$1 where id=$2",[JSON.stringify({total:575,services:['house'],salesNotes:'new note'}),id]);
 await db.exec('reset role');
 row=(await db.query('select * from jobs')).rows[0];assert.equal(row.status,'completed');assert.equal(row.details.salesNotes,'new note');assert.equal(row.details.serviceM8Status,'Completed');
 await sync('Unsuccessful');assert.equal((await db.query('select status from jobs')).rows[0].status,'cancelled');
 const booking={startAt:'2026-11-03T20:00:00Z',endAt:'2026-11-03T21:00:00Z',timeZone:'Pacific/Auckland'};
 await sync('Work Order',booking);row=(await db.query('select * from jobs')).rows[0];assert.equal(row.status,'scheduled');assert.equal(new Date(row.scheduled_date).toISOString().slice(0,10),'2026-11-04');
 await sync('Work Order',null,true);assert.equal(new Date((await db.query('select scheduled_date from jobs')).rows[0].scheduled_date).toISOString().slice(0,10),'2026-11-04');
 await db.exec('set role service_role');await assert.rejects(db.query('select sync_servicem8_job_state($1,$2,$3,$4,$5)',['foreign',id,'Completed',null,false]),/not found/);await db.exec('reset role');
 await db.exec("insert into integration_tasks values('dispatch_seed')");
 assert.equal((await db.query("select has_function_privilege('authenticated','sync_servicem8_job_state(text,uuid,text,jsonb,boolean)','execute') allowed")).rows[0].allowed,false);
 }finally{await db.close();}
});
