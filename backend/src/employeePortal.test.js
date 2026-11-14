import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { installPostJobChecklist } from './postJobChecklist.js'
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const owner=id(1),worker=id(2),manager=id(3),other=id(4),foreign=id(5),remote=id(20),generation=id(30),job=id(10)
const sql=name=>fs.readFileSync(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8')
const isolation=sql('20261114060619_employee_portal_isolation.sql')

test('portal route validates dates and forwards only trusted identity with bounded horizons',async()=>{
  const routes={},guard=()=>{},app={};for(const m of ['get','put','post'])app[m]=(p,g,h)=>{assert.equal(g,guard);routes[m+' '+p]=h}
  let params
  const db={rpc:async(name,p)=>{assert.equal(name,'job_work_portal');params=p;return{data:{employee:{id:worker,name:'Luca',aliases:[worker]},business:{name:'Nova',logoUrl:''},jobs:[]},error:null}}}
  installPostJobChecklist(app,{db,requireBusiness:guard})
  const run=async query=>{const res={statusCode:200,status(n){this.statusCode=n;return this},json(v){this.body=v;return this},set(k,v){this.header=[k,v]}};await routes['get /api/job-work/portal']({query,businessId:'a',userId:worker},res);return res}
  const result=await run({date:'2026-11-14',businessId:'b',employeeId:owner})
  assert.deepEqual(params,{p_business_id:'a',p_employee_id:worker,p_from:'2026-10-31',p_to:'2026-12-15'})
  assert.deepEqual(result.header,['Cache-Control','no-store']);assert.equal(result.body.employee.id,worker)
  assert.equal((await run({from:'2026-11-14',to:'2026-11-21'})).statusCode,200)
  for(const query of [{date:'2026-02-30'},{date:['2026-11-14']},{from:'2026-11-14'},{from:'2026-11-14',to:'2026-11-14'},{from:'2026-11-14',to:'2027-11-14'},{date:'2026-11-14',from:'2026-11-14',to:'2026-11-15'}])assert.equal((await run(query)).statusCode,400)
})

test('portal SQL and restrictive security migration preserve trusted operations while isolating employee accounts',async t=>{
  const db=new PGlite();t.after(()=>db.close())
  await db.exec(`
    create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema turnkey_private;create schema storage;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,turnkey_private,storage to anon,authenticated,service_role;
    create table businesses(id text primary key,name text,logo_url text,pricing_config jsonb);
    create table users(id uuid primary key,business_id text,role text,name text,email text);
    create table customers(id uuid primary key,business_id text,name text,email text,phone text,address text,suburb text,notes text);
    create table jobs(id uuid primary key,business_id text,customer_id uuid,quote_id text,status text default 'scheduled',scheduled_date date,assigned_to uuid,details jsonb,updated_at timestamptz default now());
    create table servicem8_connections(business_id text,generation uuid);
    create table external_object_mappings(business_id text,connection_generation uuid,object_type text,local_id text,external_uuid text,snapshot jsonb);
    create table calendar_events(id uuid primary key,business_id text,source text,external_id text,start_time timestamptz,end_time timestamptz,details jsonb);
    create table storage.objects(id uuid,bucket_id text,name text);
    alter table storage.objects enable row level security;
    create policy old_storage on storage.objects for all to authenticated using(true) with check(true);
    grant select,insert,update,delete on storage.objects to authenticated;
    insert into storage.objects values('${id(100)}','turnkey-uploads','a/private-job-photo'),('${id(101)}','business-logos','public/logo');
    insert into businesses values('a','Nova Exterior','https://logo.test/nova.png','{"wages":999,"margin":555}'),('b','Other',null,'{"costs":444}');
    insert into users values('${owner}','a','owner','Elliot','owner@nova.test'),('${worker}','a','technician',null,'luca@nova.test'),('${manager}','a','manager','Manager','manager@nova.test'),('${other}','a','technician','Other','other@nova.test'),('${foreign}','b','owner','Foreign','foreign@nova.test');
    insert into servicem8_connections values('a','${generation}');
    insert into external_object_mappings values('a','${generation}','staff_identity','${worker}','${remote}',null),('a','${generation}','staff','servicem8:${remote}','${remote}','{"name":"Luca Anderson","email":"private-staff-email@nova.test"}');
    insert into customers values('${id(40)}','a','Customer','customer@example.test','021234567','1 Main St','Town','CUSTOMER PRIVATE NOTES'),('${id(41)}','a','Unassigned customer','PRIVATE@otherjob.test','000','Other address','Other town','OTHER PRIVATE NOTES'),('${id(42)}','b','Foreign','FOREIGN@other.test','000','Foreign address','Foreign town','FOREIGN PRIVATE NOTES');
    create function turnkey_private.current_business_id() returns text language sql stable security definer set search_path='' as $$select business_id from public.users where id=auth.uid()$$;
    create function turnkey_private.current_business_role() returns text language sql stable security definer set search_path='' as $$select role from public.users where id=auth.uid()$$;
    revoke all on function turnkey_private.current_business_id(),turnkey_private.current_business_role() from public;
    grant execute on function turnkey_private.current_business_id(),turnkey_private.current_business_role() to anon,authenticated,service_role;
    -- Actual live user-policy predicates, with the existing nonrecursive helper.
    alter table users enable row level security;
    create policy "same business select" on users for select to authenticated using(id=auth.uid() or business_id=turnkey_private.current_business_id());
    create policy "self update profile" on users for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
    grant select on users to authenticated;grant update(name) on users to authenticated;
    grant select,insert,update on users,jobs,customers,businesses,servicem8_connections,external_object_mappings,calendar_events to service_role;
  `)
  // Recreate the audited tenant-wide policy shape, deliberately including
  // table grants on backend-only fixtures to prove restrictive policy defense.
  const privateTables=['jobs','customers','quotes','invoices','businesses','crm_state','sales_settings','sales_goals','sales_spend','sales_events','quote_versions','pricing_learning_observations','external_object_mappings','servicem8_connections','emails','email_accounts','calendar_connections','calendar_events','integration_tasks','attachments','activity_log','notifications','unexpected_private_table']
  for(const table of privateTables){
    if(!['jobs','customers','businesses','servicem8_connections','external_object_mappings','calendar_events'].includes(table))await db.exec(`create table public.${table}(id uuid default gen_random_uuid(),business_id text,payload jsonb);insert into public.${table}(business_id,payload) values('a','{"commercial":"SECRET FINANCIAL DATA"}'),('b','{"commercial":"FOREIGN DATA"}');`)
    await db.exec(`alter table public.${table} enable row level security;create policy tenant_wide on public.${table} for all to authenticated using(${table==='businesses'?'id':'business_id'}=turnkey_private.current_business_id()) with check(${table==='businesses'?'id':'business_id'}=turnkey_private.current_business_id());grant select,insert,update,delete on public.${table} to authenticated;`)
  }
  await db.exec(`create view public.email_accounts_status as select * from email_accounts;create view public.calendar_connections_status as select * from calendar_connections;grant select on email_accounts_status,calendar_connections_status to authenticated;`)
  await db.exec(sql('20261112235542_employee_post_job_checklist.sql'))
  // Execute the real signed quote and public booking implementations against
  // fixtures; neither RPC is changed by the employee isolation migration.
  await db.exec(`alter table quotes add column public_token uuid,add column lead_id text,add column status text default 'draft',add column amount numeric default 100,add column created_at timestamptz default now();
    alter table quote_versions add column quote_id uuid,add column snapshot jsonb,add column created_at timestamptz default now();
    update quotes set public_token='${id(99)}' where business_id='a';
    alter table businesses add column phone text,add column email text,add column region text,add column accent_color text,add column primary_color text,add column font_style text,add column policies_config jsonb;
    create function public.current_business_id() returns text language sql stable as $$select turnkey_private.current_business_id()$$;
    create function public.current_business_role() returns text language sql stable as $$select turnkey_private.current_business_role()$$;
    insert into businesses(id,name) values('83c8112c-ad39-468d-b384-de593767e291','Post Office');
    insert into users values('${id(6)}','83c8112c-ad39-468d-b384-de593767e291','technician','Post Office Worker','postoffice@example.test');`)
  const salesSql=sql('20261015061746_sales_platform.sql')
  await db.exec(salesSql.slice(salesSql.indexOf('create or replace function public.get_public_quote('),salesSql.indexOf('-- Audit versions cannot be rewritten')))
  await db.exec(sql('20261018100454_public_booking_profile.sql'))
  await db.exec(sql('20261109081047_post_office_workspaces.sql'))
  await db.exec(`insert into post_office_workspaces(business_id,state) values('83c8112c-ad39-468d-b384-de593767e291','{"projects":[{"id":"p1","checklist":[{"id":"t1","done":false}]}]}')`)
  const details={calendarStartAt:'2026-11-14T01:00:00Z',calendarEndAt:'2026-11-14T03:00:00Z',jobStatus:'in_progress',postJobCompletedAt:null,workerInstructions:'Use the side gate.',assignedStaffIds:['servicem8:'+remote,manager],services:[{label:'House wash',price:999,cost:555},{svc:'Driveway',margin:222}],salesNotes:'SECRET SALES',notes:'SECRET JOB NOTES',customerNotes:'SECRET CUSTOMER',price:999,cost:555,serviceM8Pricing:{total:999},unknown:{secret:'SECRET'}}
  await db.query('insert into jobs(id,business_id,customer_id,quote_id,scheduled_date,assigned_to,details) values($1,$2,$3,$4,$5,$6,$7)',[job,'a',id(40),'commercial-quote-id','2026-11-14',null,JSON.stringify(details)])
  for(const [n,biz,date,assigned,customer] of [[11,'a','2026-11-14',other,id(41)],[12,'b','2026-11-14',foreign,id(42)],[13,'a','2026-11-22',worker,id(40)],[14,'a','2026-11-21',worker,id(40)],[15,'a','2026-11-14',owner,id(40)]])await db.query('insert into jobs(id,business_id,customer_id,scheduled_date,assigned_to,details) values($1,$2,$3,$4,$5,$6)',[id(n),biz,customer,date,assigned,'{}'])
  await db.exec(isolation)
  async function asRole(role,employee,fn){await db.exec(`set role ${role};select set_config('request.jwt.claim.sub','${employee}',false)`);try{return await fn()}finally{await db.exec('reset role')}}
  const portal=(employee=worker,from='2026-11-14',to='2026-11-21',biz='a')=>asRole('service_role',employee,async()=>(await db.query('select job_work_portal($1,$2,$3,$4) result',[biz,employee,from,to])).rows[0].result)
  await t.test('portal is a strict field allowlist, same-tenant assigned only, and safe own-brand identity',async()=>{
    const result=await portal();assert.deepEqual(Object.keys(result).sort(),['business','employee','jobs'])
    assert.deepEqual(result.business,{id:'a',name:'Nova Exterior',logoUrl:'https://logo.test/nova.png'})
    assert.deepEqual(result.employee,{id:worker,name:'Luca Anderson',aliases:[worker,'servicem8:'+remote]})
    assert.equal(result.jobs.length,1);const output=result.jobs[0]
    assert.deepEqual(Object.keys(output).sort(),['crew','customer','details','id','scheduled_date','services','status'])
    assert.deepEqual(output.customer,{name:'Customer',email:'customer@example.test',phone:'021234567',address:'1 Main St',suburb:'Town'})
    assert.deepEqual(output.services,['House wash','Driveway']);assert.deepEqual(output.crew,['Luca Anderson','Manager'])
    assert.deepEqual(Object.keys(output.details).sort(),['assignedStaffIds','calendarEndAt','calendarStartAt','jobStatus','postJobCompletedAt','workerInstructions'])
    assert.equal(output.details.workerInstructions,'Use the side gate.')
    const text=JSON.stringify(result);for(const secret of ['SECRET','999','555','commercial-quote-id','private-staff-email','PRIVATE@otherjob','FOREIGN@'])assert.equal(text.includes(secret),false,secret)
  })
  await t.test('horizon, stale/foreign aliases, manager own assignment, tenant and bounds',async()=>{
    assert.deepEqual((await portal(owner)).jobs.map(j=>j.id),[id(15)])
    assert.deepEqual((await portal(manager)).jobs.map(j=>j.id),[job])
    assert.deepEqual((await portal(worker,'2026-11-14','2026-11-22')).jobs.map(j=>j.id),[job,id(14)])
    await db.query('update external_object_mappings set connection_generation=$1 where object_type=$2',[id(31),'staff_identity'])
    assert.equal((await portal()).jobs.length,0)
    await db.query('update external_object_mappings set business_id=$1,connection_generation=$2 where object_type=$3',['b',generation,'staff_identity'])
    assert.equal((await portal()).jobs.length,0)
    await db.query('update external_object_mappings set business_id=$1 where object_type=$2',['a','staff_identity'])
    await assert.rejects(portal(worker,'2026-11-14','2027-11-14'),/93 days/)
    await assert.rejects(portal(worker,'2026-11-14','2026-11-21','b'),/Staff member/)
  })
  await t.test('dispatch-only assignments require a current canonical activity, identity, interval and tenant; reads never create jobs',async()=>{
    const localJob=id(16),upstream=id(60),activity=id(61),eventId=id(62)
    const booking={activityUuid:activity,jobUuid:upstream,source:'servicem8',startAt:'2026-11-14T22:00:00Z',endAt:'2026-11-14T23:00:00Z',timeZone:'Pacific/Auckland',assignedStaffIds:['servicem8:'+remote]}
    const snapshot={status:'Work Order',booking}
    const eventDetails={jobUuid:upstream,source:'jobactivity',assignedStaffIds:['servicem8:'+remote],pricing:{total:999},notes:'SECRET'}
    await db.query(`insert into jobs(id,business_id,customer_id,details) values($1,'a',$2,$3)`,[localJob,id(40),JSON.stringify({assignedStaffIds:[],workerInstructions:'Dedicated instructions',services:[{label:'Roof wash',price:999}],notes:'SECRET'})])
    await db.query(`insert into external_object_mappings values('a',$1,'job',$2,$3,$4)`,[generation,localJob,upstream,JSON.stringify(snapshot)])
    await db.query(`insert into calendar_events values($1,'a','servicem8',$2,$3,$4,$5)`,[eventId,activity,booking.startAt,booking.endAt,JSON.stringify(eventDetails)])
    const access=()=>asRole('service_role',worker,async()=>(await db.query('select job_work_dispatch_access($1,$2,$3) allowed',['a',localJob,worker])).rows[0].allowed)
    const checklist=()=>asRole('service_role',worker,async()=>(await db.query(`select post_job_checklist('a',$1,$2,'get') result`,[localJob,worker])).rows[0].result)
    const count=(await db.query('select count(*)::int n from jobs')).rows[0].n
    const result=(await portal()).jobs.find(j=>j.id===localJob)
    assert.ok(result);assert.equal(result.scheduled_date,'2026-11-15')
    assert.equal(Date.parse(result.details.calendarStartAt),Date.parse(booking.startAt))
    assert.deepEqual(result.details.assignedStaffIds,['servicem8:'+remote]);assert.deepEqual(result.crew,['Luca Anderson'])
    assert.equal(JSON.stringify(result).includes('SECRET'),false);assert.equal(JSON.stringify(result).includes('999'),false)
    assert.equal(await access(),true);assert.equal((await checklist()).checklist,null)
    assert.equal((await db.query('select count(*)::int n from jobs')).rows[0].n,count)
    const badEvents=[{business_id:'b'},{source:'turnkey'},{external_id:id(63)},{start_time:'2026-11-15T01:00:00Z'},{details:{...eventDetails,jobUuid:id(64)}},{details:{...eventDetails,assignedStaffIds:['servicem8:'+id(65)]}}]
    for(const patch of badEvents){
      const [key,value]=Object.entries(patch)[0]
      await db.query(`update calendar_events set ${key}=$1 where id=$2`,[key==='details'?JSON.stringify(value):value,eventId])
      assert.equal(await access(),false,key);await assert.rejects(checklist(),/assigned/)
      assert.ok(!(await portal()).jobs.some(j=>j.id===localJob),key)
      await db.query(`update calendar_events set business_id='a',source='servicem8',external_id=$1,start_time=$2,details=$3 where id=$4`,[activity,booking.startAt,JSON.stringify(eventDetails),eventId])
    }
    for(const bad of [{status:'Unsuccessful',booking},{status:'Work Order',booking:{...booking,jobUuid:id(64)}},{status:'Work Order',booking:{...booking,activityUuid:id(64)}},{status:'Work Order',booking:{...booking,startAt:'malformed'}},{status:'Work Order',booking:{...booking,assignedStaffIds:[]}}]){
      await db.query(`update external_object_mappings set snapshot=$1 where object_type='job' and local_id=$2`,[JSON.stringify(bad),localJob])
      assert.equal(await access(),false);await assert.rejects(checklist(),/assigned/)
    }
    await db.query(`update external_object_mappings set snapshot=$1,connection_generation=$2 where object_type='job' and local_id=$3`,[JSON.stringify(snapshot),id(31),localJob])
    assert.equal(await access(),false)
    await db.query(`update external_object_mappings set connection_generation=$1 where object_type='job' and local_id=$2`,[generation,localJob])
    await db.query(`update external_object_mappings set connection_generation=$1 where object_type='staff_identity'`,[id(31)])
    assert.equal(await access(),false)
    await db.query(`update external_object_mappings set connection_generation=$1 where object_type='staff_identity'`,[generation])
    const responses={customerHome:false,injectorFlushed:true,fuelSwitchOff:true,objectsReturned:true,propertyLap:true}
    await asRole('service_role',worker,async()=>{
      const completed=(await db.query(`select post_job_checklist('a',$1,$2,'complete',$3) result`,[localJob,worker,JSON.stringify(responses)])).rows[0].result
      assert.equal(completed.checklist.employeeId,worker);assert.ok(completed.checklist.completedAt)
      assert.equal(completed.statusManagedByServiceM8,true);assert.equal(completed.job.status,'scheduled')
    })
    await db.query('delete from calendar_events where id=$1',[eventId])
    await db.query(`delete from external_object_mappings where object_type='job' and local_id=$1`,[localJob])
  })
  await t.test('technicians cannot read or write raw commercial/CRM/integration rows; own profile remains readable without recursion',async()=>{
    await asRole('authenticated',worker,async()=>{
      for(const table of privateTables){assert.equal((await db.query(`select * from public.${table}`)).rows.length,0,table);assert.equal((await db.query(`delete from public.${table} returning *`)).rows.length,0,table)}
      assert.deepEqual((await db.query('select id,business_id,role from users')).rows,[{id:worker,business_id:'a',role:'technician'}])
      await db.query(`update users set name='Luca profile' where id=$1`,[worker])
      await assert.rejects(db.query(`insert into sales_spend(business_id,payload) values('a','{}')`),/row-level security/)
      assert.equal((await db.query('select * from email_accounts_status')).rows.length,0)
      assert.equal((await db.query('select * from calendar_connections_status')).rows.length,0)
      assert.equal((await db.query(`select * from storage.objects where bucket_id='turnkey-uploads'`)).rows.length,0)
      await assert.rejects(db.query(`insert into storage.objects values($1,'turnkey-uploads','a/bypass')`,[id(102)]),/row-level security/)
      await assert.rejects(db.query('select job_work_portal($1,$2,$3,$4)',['a',worker,'2026-11-14','2026-11-21']),/permission denied/)
    })
  })
  await t.test('owners/managers retain tenant CRM access; service portal/checklists and approved token RPCs still work',async()=>{
    for(const employee of [owner,manager])await asRole('authenticated',employee,async()=>{
      assert.equal((await db.query('select * from customers')).rows.length,2)
      assert.equal((await db.query('select pricing_config from businesses')).rows[0].pricing_config.wages,999)
      assert.equal((await db.query('select * from invoices')).rows.length,1)
      assert.equal((await db.query('select * from sales_spend')).rows.length,1)
      assert.equal((await db.query('select * from users')).rows.length,4)
    })
    await asRole('authenticated',foreign,async()=>assert.equal((await db.query('select * from customers')).rows.length,1))
    assert.equal((await portal()).jobs.length,1)
    await asRole('service_role',worker,async()=>{assert.equal((await db.query(`select post_job_checklist('a',$1,$2,'save','{"customerHome":null}') result`,[job,worker])).rows[0].result.checklist.employeeId,worker)})
    await asRole('anon',worker,async()=>{
      assert.equal((await db.query('select get_public_quote($1) result',[id(99)])).rows[0].result.amount,100)
      assert.equal((await db.query('select get_public_quote($1) result',[id(98)])).rows[0].result.error,'not_found')
      const brand=(await db.query(`select get_public_business('a') result`)).rows[0].result
      assert.equal(brand.name,'Nova Exterior');assert.equal(brand.wages,undefined)
    })
    await asRole('authenticated',worker,async()=>assert.equal((await db.query(`select get_public_quote($1) result`,[id(99)])).rows[0].result.amount,100))
    await asRole('authenticated',id(6),async()=>{
      assert.equal((await db.query('select * from post_office_workspaces')).rows.length,1)
      assert.equal((await db.query('select * from users')).rows.length,1)
      const toggled=(await db.query(`select post_office_toggle_task('p1','t1',true) result`)).rows[0].result
      assert.equal(toggled.state.projects[0].checklist[0].done,true)
    })
    await asRole('authenticated',worker,async()=>assert.rejects(db.query(`select post_office_toggle_task('p1','t1',false)`),/company membership/))
    await db.exec(isolation) // additive migration is replay-safe
  })
})
