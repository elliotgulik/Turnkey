const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let db;
test.before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table users(id uuid primary key,business_id text,role text);
 create table jobs(id uuid primary key,business_id text,status text,scheduled_date date,assigned_to uuid,details jsonb default '{}');
 create table availability_blocks(id uuid primary key,business_id text,user_id uuid,block_type text,start_at timestamptz,end_at timestamptz,all_day boolean,reason text,created_by uuid);
 create table calendar_events(id uuid primary key,business_id text,user_id uuid,busy_status text,start_time timestamptz,end_time timestamptz,external_id text);
 insert into users values ('${id(1)}','a','owner'),('${id(2)}','a','technician'),('${id(3)}','a','technician'),('${id(4)}','b','technician');
 insert into jobs(id,business_id,status,details) values ('${id(11)}','a','quoted','{"services":[{"svc":"deck","qty":10}],"total":500}'),('${id(12)}','a','quoted','{"googleEventId":"existing-google-event"}'),('${id(13)}','a','quoted','{}');`);
 const sql=fs.readFileSync(require('node:path').join(__dirname,'../supabase/migrations/20261018094524_job_calendar_booking.sql'),'utf8');await db.exec(sql);await db.exec(sql);
});
test.after(async()=>await db?.close());
function book(j,start,end,staff=[id(2)],actor=id(1)){return db.query('select * from job_calendar_book($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',['a',actor,j,start,end,'Pacific/Auckland',staff,'Crew','',false,480,60])}
test('calendar booking preserves the sales stage and quoted pricing',async()=>{
 const result=await book(id(11),'2026-10-19T19:00Z','2026-10-19T20:00Z',[id(2),id(3)]);
 assert.equal(result.rows[0].status,'quoted','scheduling is not a new won sale');
 assert.equal(result.rows[0].details.total,500);assert.equal(result.rows[0].details.wonAt,undefined);
 await assert.rejects(book(id(13),'2026-10-19T19:30Z','2026-10-19T20:30Z',[id(3)]),/conflict/i);
 await book(id(13),'2026-10-19T20:00Z','2026-10-19T21:00Z',[id(3)]); // adjacent is valid
 await assert.rejects(book(id(13),'2026-10-21T19:00Z','2026-10-21T20:00Z',[id(4)]),/business/i);
});
test('native busy time with a null external ID still conflicts for a Google-linked job',async()=>{
 await db.query('insert into calendar_events values ($1,$2,$3,$4,$5,$6,null)',[id(30),'a',id(2),'busy','2026-10-22T19:00Z','2026-10-22T20:00Z']);
 await assert.rejects(book(id(12),'2026-10-22T19:00Z','2026-10-22T20:00Z'),/busy|conflict/i);
});
test('a technician cannot reuse another block ID to replace a business closure',async()=>{
 const args=['a',id(1),id(40),'2026-10-25T19:00Z','2026-10-26T19:00Z',true,null,'business_closed','Closed'];
 await db.query('select * from job_calendar_upsert_block($1,$2,$3,$4,$5,$6,$7,$8,$9)',args);
 args[1]=id(2);args[6]=id(2);args[7]='personal';
 await assert.rejects(db.query('select * from job_calendar_upsert_block($1,$2,$3,$4,$5,$6,$7,$8,$9)',args),/own|permission|business|block/i);
 const row=(await db.query('select user_id,block_type from availability_blocks where id=$1',[id(40)])).rows[0];assert.equal(row.user_id,null);assert.equal(row.block_type,'business_closed');
 const grants=await db.query("select has_function_privilege('authenticated','job_calendar_book(text,uuid,uuid,timestamptz,timestamptz,text,uuid[],text,text,boolean,int,int)','execute') as can_book");assert.equal(grants.rows[0].can_book,false);
});
