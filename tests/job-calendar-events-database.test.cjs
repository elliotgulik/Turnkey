const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('independent calendar SQL: real schema, private RPCs, ownership, conflicts and repeatability', async t => {
 const db = new PGlite();
 try {
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function current_business_id() returns text language sql stable as $$select current_setting('test.business',true)$$;
 create table users(id uuid primary key,business_id text,role text);
 create function current_business_role() returns text language sql stable as $$select role from users where id=auth.uid()$$;
 create table jobs(id uuid primary key,business_id text,customer_id uuid,status text,scheduled_date date,assigned_to uuid,details jsonb default '{}');`);
 // Load the actual calendar schema and earlier native extension (not a mock).
 const base = fs.readFileSync(path.join(__dirname,'../backend/supabase/schema-calendar-and-checklists.sql'),'utf8').split('-- ===== Per-business, per-service')[0];
 await db.exec(base);
 const native = fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260810100000_native_calendar_events_blocks_hours.sql'),'utf8').split('-- ===== Per-employee')[0];
 await db.exec(native);
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261018094524_job_calendar_booking.sql'),'utf8'));
 const sql = fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261018100839_job_calendar_independent_events.sql'),'utf8');
 await db.exec(`grant usage on schema public,auth to anon,authenticated,service_role;
 grant select,insert,update,delete on all tables in schema public to authenticated,service_role;
 insert into users values ('${id(1)}','a','owner'),('${id(2)}','a','manager'),('${id(3)}','a','technician'),('${id(4)}','a','technician'),('${id(5)}','b','owner');
 insert into jobs values ('${id(20)}','a','${id(99)}','quoted',null,'${id(3)}','{"total":500,"wonAt":"preserve","services":["deck"],"calendarNotes":"keep"}');`);
 await db.exec(sql);
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261031133000_servicem8_dispatch_calendar.sql'),'utf8'));
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261031140000_servicem8_dispatch_webhook.sql'),'utf8'));
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261031150000_servicem8_dispatch_event_details.sql'),'utf8'));
 const event = (n=30, caller=1, staff=3, patch={}) => {
   const args = ['a',id(caller),id(n),id(staff),'Site visit','2026-10-19T08:00Z','2026-10-19T09:00Z','busy','notes','UTC'];
   for (const [k,v] of Object.entries(patch)) args[Number(k)]=v;
   return db.query('select * from job_calendar_upsert_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',args);
 };
 const remove = (n,caller=1,kind='event',biz='a') => db.query('select job_calendar_delete_item($1,$2,$3,$4)',[biz,id(caller),id(n),kind]);
 const book = (start='2026-10-20T08:00Z',end='2026-10-20T09:00Z') => db.query('select * from job_calendar_book($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',['a',id(1),id(20),start,end,'UTC',[id(3)],'Crew','keep',true,480,60]);
 const unschedule = (caller=1,biz='a') => db.query('select * from job_calendar_unschedule($1,$2,$3)',[biz,id(caller),id(20)]);
 const reject = (promise,code) => assert.rejects(promise,e => e.code===code);
 await t.test('ServiceM8 dispatch sync is service-role only, idempotent, and prunes canceled bookings only in-range',async()=>{
   const from='2026-11-01T00:00:00Z',to='2026-11-08T00:00:00Z';
   const details={personName:'Alex Smith',email:'alex@example.test',services:['House wash'],assignedStaff:['Jordan Lee']};
   const events=[{external_id:'activity-1',title:'Alex Smith · House wash',start_time:'2026-11-04T09:00:00Z',end_time:'2026-11-04T10:00:00Z',notes:'29 Selwyn Cres',details},
     {external_id:'activity-2',title:'Nova · Driveway',start_time:'2026-11-09T09:00:00Z',end_time:'2026-11-09T10:00:00Z',notes:null}];
   await assert.rejects(db.query('select sync_servicem8_dispatch_calendar($1,$2,$3,$4)', ['a',from,to,JSON.stringify(events)]),e=>e.code==='42501');
   await db.exec('set role service_role');
   try {
     const first=await db.query('select sync_servicem8_dispatch_calendar($1,$2,$3,$4) n',['a',from,to,JSON.stringify(events)]);
     assert.equal(first.rows[0].n,1,'out-of-range bookings are rejected');
     const repeated=await db.query('select sync_servicem8_dispatch_calendar($1,$2,$3,$4) n',['a',from,to,JSON.stringify(events)]);
     assert.equal(repeated.rows[0].n,1);
     assert.equal((await db.query("select count(*)::int n from calendar_events where source='servicem8'")).rows[0].n,1);
     assert.deepEqual((await db.query("select details from calendar_events where source='servicem8'")).rows[0].details,details);
     await db.query('select sync_servicem8_dispatch_calendar($1,$2,$3,$4)',['a',from,to,'[]']);
     assert.equal((await db.query("select count(*)::int n from calendar_events where source='servicem8'")).rows[0].n,0);
     assert.equal((await db.query("select count(*)::int n from calendar_events where source='turnkey'")).rows[0].n,0);
     const item={title:'Webhook booking',start_time:'2026-11-04T20:00:00Z',end_time:'2026-11-04T21:00:00Z',notes:'Address',details};
     await db.query('select sync_servicem8_dispatch_event($1,$2,$3)',['a','activity-live',JSON.stringify(item)]);
     await db.query('select sync_servicem8_dispatch_event($1,$2,$3)',['a','activity-live',JSON.stringify({...item,title:'Moved booking'})]);
     assert.equal((await db.query("select title from calendar_events where source='servicem8'")).rows[0].title,'Moved booking');
     assert.deepEqual((await db.query("select details from calendar_events where source='servicem8'")).rows[0].details,details);
     await db.query('select sync_servicem8_dispatch_event($1,$2,$3)',['a','activity-live',null]);
     assert.equal((await db.query("select count(*)::int n from calendar_events where source='servicem8'")).rows[0].n,0);
   } finally { await db.exec('reset role'); }
 });
 await t.test('owner, manager and technician own event; stable UUID retry and edit',async()=>{
   await event(); await event(); await event(30,2,3,{4:'Updated'});
   assert.equal((await db.query('select count(*)::int n from calendar_events')).rows[0].n,1);
   await event(31,3,3,{5:'2026-10-19T09:00Z',6:'2026-10-19T10:00Z'});
   await event(31,3,3,{4:'Tech edited',5:'2026-10-19T09:00Z',6:'2026-10-19T10:00Z'});
 });
 await t.test('tenant/caller spoofing, reassignment and takeover rejected',async()=>{
   await reject(event(32,3,4),'42501'); await reject(event(30,4,4),'42501');
   await reject(event(30,5,3),'42501'); await reject(event(32,1,5),'22023');
   await reject(event(31,3,4),'42501'); await reject(remove(30,4),'42501');
   await reject(remove(30,5,'event','b'),'22023');
   await reject(event(30,5,5,{0:'b'}),'22023');
 });
 await t.test('external and incorrectly tagged connected/imported rows never overwritten/deleted',async()=>{
   for (const [n,source,external,connection] of [[40,'external','import',null],[41,'turnkey','import',null],[42,'turnkey',null,id(80)]]) {
     if(connection) await db.query('insert into calendar_connections(id,business_id,user_id,provider) values ($1,$2,$3,$4)',[connection,'a',id(3),'google']);
     await db.query('insert into calendar_events(id,business_id,user_id,source,external_id,connection_id,start_time,end_time) values($1,$2,$3,$4,$5,$6,$7,$8)',[id(n),'a',id(3),source,external,connection,'2026-11-01','2026-11-02']);
     await reject(event(n),'42501'); await reject(remove(n),'42501');
   }
 });
 await t.test('busy conflicts both directions; free events allowed; adjacent windows allowed',async()=>{
   await reject(event(33),'23P01');
   await event(33,1,3,{7:'free'});
   await reject(book('2026-10-19T08:00Z','2026-10-19T09:00Z'),'23P01');
   await book(); await reject(event(34,1,3,{5:'2026-10-20T08:30Z',6:'2026-10-20T09:30Z'}),'23P01');
   await event(34,1,3,{5:'2026-10-20T09:00Z',6:'2026-10-20T10:00Z'});
   await db.query('select * from job_calendar_upsert_block($1,$2,$3,$4,$5,$6,$7,$8,$9)',['a',id(3),id(50),'2026-10-21T08:00Z','2026-10-21T10:00Z',false,id(3),'personal','leave']);
   await reject(event(35,1,3,{5:'2026-10-21T08:00Z',6:'2026-10-21T09:00Z'}),'23P01');
 });
 await t.test('block edits/deletes enforce existing ownership under shared lock',async()=>{
   const args=['a',id(3),id(50),'2026-10-22T08:00Z','2026-10-22T10:00Z',false,id(3),'personal','moved'];
   await db.query('select * from job_calendar_upsert_block($1,$2,$3,$4,$5,$6,$7,$8,$9)',args);
   args[1]=id(4);args[6]=id(4);
   await reject(db.query('select * from job_calendar_upsert_block($1,$2,$3,$4,$5,$6,$7,$8,$9)',args),'42501');
   await reject(remove(50,4,'block'),'42501'); await remove(50,3,'block');
 });
 await t.test('unschedule preserves sales/customer/assignment/Google reference, idempotent; late sync cannot revive it',async()=>{
   await db.query(`update jobs set details=details||'{"googleEventId":"remote-keep","_googleEventOwnerId":"${id(1)}"}'::jsonb where id=$1`,[id(20)]);
   await reject(unschedule(3),'42501'); await reject(unschedule(5,'b'),'22023');
   const row=(await unschedule()).rows[0];
   assert.equal(row.status,'quoted');assert.equal(row.customer_id,id(99)); assert.equal(row.assigned_to,id(3));assert.equal(row.details.total,500);assert.equal(row.details.wonAt,'preserve');
   assert.equal(row.details.calendarStartAt,undefined);assert.equal(row.scheduled_date,null);assert.equal(row.details.googleEventId,'remote-keep');assert.equal(row.details.calendarGoogleSync,false);
   assert.deepEqual((await unschedule()).rows[0],row);
   const late=(await db.query('select * from job_calendar_set_google_status($1,$2,$3)',['a',id(20),'{"calendarGoogleSync":true,"calendarGoogleSyncState":"synced"}'])).rows[0];
   assert.equal(late.details.calendarGoogleSync,false);assert.equal(late.details.calendarGoogleSyncState,'detached');
   assert.equal((await db.query('select count(*)::int n from calendar_events where source=\'external\'')).rows[0].n,1);
   await book(); assert.equal((await db.query('select details from jobs')).rows[0].details.calendarGoogleSync,true);
 });
 await t.test('competing overlapping event creates cannot both succeed',async()=>{
   const outcomes=await Promise.allSettled([
     event(60,1,4,{5:'2026-12-01T08:00Z',6:'2026-12-01T09:00Z'}),
     event(61,2,4,{5:'2026-12-01T08:00Z',6:'2026-12-01T09:00Z'})
   ]);
   assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
   assert.equal(outcomes.find(r=>r.status==='rejected').reason.code,'23P01');
 });
 await t.test('RLS reads scope technician to own events and business blocks; owner sees business only',async()=>{
   await db.query('insert into calendar_events(id,business_id,user_id,source,start_time,end_time) values($1,$2,$3,$4,$5,$6)',[id(70),'b',id(5),'turnkey','2026-12-02','2026-12-03']);
   await db.exec(`set request.jwt.claim.sub='${id(3)}';set test.business='a';set role authenticated`);
   try {
     const rows=(await db.query('select * from calendar_events')).rows;
     assert.ok(rows.length>0);assert.ok(rows.every(e=>e.user_id===id(3)&&e.business_id==='a'));
   } finally {await db.exec('reset role');}
   await db.exec(`set request.jwt.claim.sub='${id(1)}';set role authenticated`);
   try {
     const rows=(await db.query('select * from calendar_events')).rows;
     assert.ok(rows.some(e=>e.user_id===id(4)));assert.ok(rows.every(e=>e.business_id==='a'));
   } finally {await db.exec('reset role');}
 });
 await t.test('invalid SQL fields and completed unschedule fail',async()=>{
   await reject(event(90,1,3,{4:''}),'22023'); await reject(event(90,1,3,{8:'x',7:'unknown'}),'22023');
   await reject(event(90,1,3,{9:'invalid'}),'22023');
   await db.exec("update jobs set status='completed'");await reject(unschedule(),'22023');
 });
 await t.test('real SQL role grants deny direct RPC and table writes; service role executes scoped functions',async()=>{
   for(const role of ['anon','authenticated']) {
     await db.exec('set role '+role);
     try {
       await reject(event(90),'42501'); await reject(remove(30),'42501');await reject(unschedule(),'42501');
       await reject(db.query('delete from calendar_events where id=$1',[id(30)]),'42501');
       await reject(db.query('update availability_blocks set reason=$1',['hack']),'42501');
     } finally { await db.exec('reset role'); }
   }
   await db.exec('set role service_role');
   try { await remove(31,3); await reject(remove(30,4),'42501'); } finally {await db.exec('reset role');}
 });
 await t.test('migration reapplication preserves data; all mutation functions share booking lock',async()=>{
   const before=(await db.query('select * from calendar_events order by id')).rows;
   await db.exec(sql); assert.deepEqual((await db.query('select * from calendar_events order by id')).rows,before);
   for(const name of ['job_calendar_book','job_calendar_upsert_block','job_calendar_upsert_event','job_calendar_delete_item','job_calendar_unschedule','job_calendar_set_google_status']) {
     const def=(await db.query('select prosrc from pg_proc where proname=$1',[name])).rows[0].prosrc;
     assert.match(def,/pg_advisory_xact_lock\(hashtextextended\(p_business_id,\s*0\)\)/);
   }
 });
 } finally {await db.close();}
});
