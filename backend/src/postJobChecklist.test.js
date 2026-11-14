import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { installPostJobChecklist, jobWorkStaffIds, jobWorkAssigned, safeReviewUrl } from './postJobChecklist.js'
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const owner=id(1), worker=id(2), other=id(3), foreign=id(4), job=id(10), remote=id(20), generation=id(30)
const valid = () => ({customerHome:true,qualityCheck:true,reviewScanned:false,askedUpcomingWork:false,upcomingWorkNotes:'',askedFrequency:false,frequencyAnswer:'',injectorFlushed:true,fuelSwitchOff:true,objectsReturned:true,propertyLap:true})
const migration = fs.readFileSync(new URL('../../supabase/migrations/20261112235542_employee_post_job_checklist.sql',import.meta.url),'utf8')
function mockDb(tables) {
  return {from(table) {
    let filters=[], change, single=false
    const q={select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},maybeSingle(){single=true;return q},single(){single=true;return q},update(v){change=v;return q},
      then(resolve,reject){const rows=(tables[table]||[]).filter(r=>filters.every(f=>f(r)));if(change)rows.forEach(r=>Object.assign(r,change));return Promise.resolve({data:single?rows[0]:rows,error:null}).then(resolve,reject)}}
    return q
  }}
}

test('review URLs are HTTPS, credential-free, bounded, and permit clearing',()=>{
  assert.equal(safeReviewUrl(' https://g.page/r/CbDFAxFaaWMUEBM/review '),'https://g.page/r/CbDFAxFaaWMUEBM/review')
  assert.equal(safeReviewUrl(''),'')
  for(const url of ['http://example.com','https:example.com','https://@example.com','javascript:alert(1)','https://user:secret@example.com','https://example.com/a b','https://example.com\\@evil.test','https://example.com/'+ 'a'.repeat(1024),null]) assert.throws(()=>safeReviewUrl(url))
})

test('aliases require explicit same-business current-generation identity links',async()=>{
  const tables={servicem8_connections:[{business_id:'a',generation}],external_object_mappings:[
    {business_id:'a',connection_generation:generation,object_type:'staff_identity',local_id:worker,external_uuid:remote},
    {business_id:'b',connection_generation:generation,object_type:'staff_identity',local_id:worker,external_uuid:id(21)},
    {business_id:'a',connection_generation:id(31),object_type:'staff_identity',local_id:worker,external_uuid:id(22)},
    {business_id:'a',connection_generation:generation,object_type:'staff',local_id:worker,external_uuid:id(23)}]}
  const ids=await jobWorkStaffIds(mockDb(tables),'a',worker)
  assert.deepEqual([...ids],[worker,'servicem8:'+remote])
  assert.equal(jobWorkAssigned({details:{assignedStaffIds:['servicem8:'+remote]}},ids),true)
  assert.equal(jobWorkAssigned({details:{assignedStaffIds:['servicem8:'+id(21)]}},ids),false)
})

test('HTTP contract: safe settings, employee identity, trusted RPC identity, failure status',async()=>{
  const routes={};const app={};const guard=()=>{}
  for(const method of ['get','put','post'])app[method]=(path,auth,handler)=>{assert.equal(auth,guard);routes[method+' '+path]=handler}
  const tables={users:[{id:worker,business_id:'a',name:'Luca',role:'technician'},{id:owner,business_id:'a',name:'Owner',role:'owner'}],businesses:[{id:'a',name:'Nova',logo_url:'https://logo.test/logo.png',post_job_settings:{enabled:true,reviewUrl:'https://g.page/review'},private:'secret'}]}
  const db=mockDb(tables);let args
  db.rpc=async(name,p)=>{if(name==='post_job_employee_name')return {data:'Luca',error:null};assert.equal(name,'post_job_checklist');args=p;return {data:{checklist:null,history:[],statusManagedByServiceM8:true},error:null}}
  installPostJobChecklist(app,{db,requireBusiness:guard})
  const run=async(key,body={},userId=worker)=>{const res={statusCode:200,status(n){this.statusCode=n;return this},json(v){this.body=v;return this}};await routes[key]({userId,businessId:'a',params:{jobId:job},body},res);return res}
  const settings=await run('get /api/job-work/post-job/settings')
  assert.deepEqual(settings.body.employee,{id:worker,name:'Luca',aliases:[worker]})
  assert.equal(settings.body.role,'technician');assert.equal(settings.body.settings.reviewUrl,'https://g.page/review');assert.equal(JSON.stringify(settings.body).includes('secret'),false)
  assert.equal((await run('put /api/job-work/post-job/settings',{enabled:false,reviewUrl:''})).statusCode,403)
  assert.equal((await run('put /api/job-work/post-job/settings',{enabled:true,reviewUrl:'http://bad'},owner)).statusCode,400)
  assert.equal((await run('put /api/job-work/post-job/settings',{enabled:false,reviewUrl:''},owner)).body.settings.enabled,false)
  const complete=await run('post /api/job-work/jobs/:jobId/post-job/complete',{responses:valid(),employeeId:owner,employeeName:'Spoof',completedAt:'2000-01-01'})
  assert.equal(args.p_employee_id,worker);assert.equal(complete.body.statusManagedBySM8,true)
  db.rpc=async()=>({error:{code:'22023',message:'Complete required check'}})
  assert.equal((await run('post /api/job-work/jobs/:jobId/post-job/complete')).statusCode,400)
  db.rpc=async()=>({error:{code:'PGRST202'}})
  assert.equal((await run('get /api/job-work/jobs/:jobId/post-job')).statusCode,503)
})

test('PostgreSQL: durable drafts, validated atomic completion, immutable audits, tenant and direct-write security',async t=>{
  const db=new PGlite()
  t.after(()=>db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,service_role;
    create table public.businesses(id text primary key,name text,logo_url text);
    create table public.users(id uuid primary key,business_id text,role text,name text,email text);
    create table public.jobs(id uuid primary key,business_id text,status text not null default 'scheduled',assigned_to uuid,details jsonb,scheduled_date date,updated_at timestamptz default now());
    create table public.servicem8_connections(business_id text primary key,generation uuid);
    create table public.external_object_mappings(business_id text,connection_generation uuid,object_type text,local_id text,external_uuid text,snapshot jsonb);
    insert into businesses values ('a','Nova',null),('b','Other',null),('041e386f-beeb-4dd8-a515-e4293629a921','Nova Exterior',null);
    insert into users values ('${owner}','a','owner','Owner','owner@example.test'),('${worker}','a','technician','Luca','worker@example.test'),('${other}','a','technician','Other','other@example.test'),('${foreign}','b','technician','Foreign','foreign@example.test');
    insert into jobs(id,business_id,assigned_to,details) values ('${job}','a','${worker}','{"private":"hidden"}'),('${id(11)}','b','${foreign}','{}'),('${id(12)}','a',null,'{"assignedStaffIds":["servicem8:${remote}"],"serviceM8Status":"Work Order"}');
    insert into servicem8_connections values ('a','${generation}');
    insert into external_object_mappings values ('a','${generation}','staff_identity','${worker}','${remote}',null);
    grant select,update,insert on public.jobs,public.businesses to authenticated;
    grant select on public.users to authenticated;
    grant select,update on public.jobs to service_role;
    grant select,update on public.users to service_role;
    grant select on public.businesses,public.servicem8_connections,public.external_object_mappings to service_role;
  `)
  await db.exec(migration)
  // Install the actual existing ServiceM8 guard, not a substitute fixture.
  await db.exec(fs.readFileSync(new URL('../../supabase/migrations/20261101082135_servicem8_readonly_pricing_snapshot.sql',import.meta.url),'utf8'))
  await db.exec('create trigger aaa_guard_servicem8_operational_state before update on jobs for each row execute function public.guard_servicem8_operational_state()')
  async function rpc(action,responses=null,{employee=worker,jobId=job,business='a'}={}) {
    await db.exec('set role service_role')
    try{return (await db.query('select public.post_job_checklist($1,$2,$3,$4,$5) as result',[business,jobId,employee,action,responses==null?null:JSON.stringify(responses)])).rows[0].result}
    finally{await db.exec('reset role')}
  }
  const count=async()=> (await db.query('select count(*)::int n from post_job_checklists')).rows[0].n
  await t.test('seed affects Nova only; all others default enabled with no URL',async()=>{
    const rows=(await db.query('select id,post_job_settings from businesses order by id')).rows
    assert.equal(rows.find(r=>r.id==='a').post_job_settings.reviewUrl,'')
    assert.equal(rows.find(r=>r.id==='b').post_job_settings.enabled,true)
    assert.equal(rows.find(r=>r.id.startsWith('041')).post_job_settings.reviewUrl,'https://g.page/r/CbDFAxFaaWMUEBM/review')
    await db.query(`update businesses set post_job_settings='{"enabled":false,"reviewUrl":"https://existing.test/review"}' where id='041e386f-beeb-4dd8-a515-e4293629a921'`)
    await db.exec(migration)
    const seeded=(await db.query(`select post_job_settings from businesses where id='041e386f-beeb-4dd8-a515-e4293629a921'`)).rows[0].post_job_settings
    assert.equal(seeded.reviewUrl,'https://existing.test/review');assert.equal(seeded.enabled,false)
  })
  await t.test('draft survives new reads, strips injected fields, isolates users and tenants',async()=>{
    assert.deepEqual(await rpc('get'),{checklist:null,history:[]})
    const saved=await rpc('save',{customerHome:null,reviewScanned:true,employeeName:'Spoof',completedAt:'2000-01-01'})
    const read=await rpc('get')
    assert.deepEqual(read.checklist,saved.checklist)
    assert.equal(read.checklist.employeeName,'Luca');assert.equal(read.checklist.completedAt,null)
    assert.equal(read.checklist.responses.employeeName,undefined)
    await assert.rejects(rpc('get',null,{employee:other}),/assigned/)
    await assert.rejects(rpc('save',{}, {employee:foreign}),/Staff member/)
    await assert.rejects(rpc('get',null,{jobId:id(11)}),/Job not found/)
  })
  await t.test('every required check, home answer, quality and text limits enforced without writes',async()=>{
    const before=await rpc('get');const n=await count()
    for(const key of ['injectorFlushed','fuelSwitchOff','objectsReturned','propertyLap','qualityCheck'])await assert.rejects(rpc('complete',{...valid(),[key]:false}),/check/i)
    await assert.rejects(rpc('complete',{...valid(),customerHome:null}),/customer.*home/)
    await assert.rejects(rpc('complete',{...valid(),customerHome:'false'}),/boolean/)
    await assert.rejects(rpc('complete',{...valid(),injectorFlushed:'true'}),/boolean/)
    for(const [key,max] of [['upcomingWorkNotes',2000],['frequencyAnswer',500]]) await assert.rejects(rpc('save',{[key]:'x'.repeat(max+1)}),/too long/)
    assert.deepEqual(await rpc('get'),before);assert.equal(await count(),n)
    assert.equal((await db.query('select status from jobs where id=$1',[job])).rows[0].status,'scheduled')
  })
  await t.test('optional review stays false; server identity and time; job privacy allowlist; immutable retry',async()=>{
    const result=await rpc('complete',valid())
    assert.equal(result.checklist.responses.reviewScanned,false)
    assert.equal(result.checklist.employeeId,worker);assert.ok(result.checklist.completedAt)
    assert.equal(result.job.status,'completed');assert.equal(result.job.details.jobStatus,'completed')
    assert.equal(result.job.details.postJobCompletedAt,result.job.details.finishedAt)
    assert.equal(result.job.details.private,undefined)
    const retry=await rpc('complete',{customerHome:null})
    assert.equal(retry.alreadyCompleted,true);assert.deepEqual(retry.checklist,result.checklist)
    assert.deepEqual((await rpc('save',{customerHome:false})).checklist,result.checklist)
    await assert.rejects(db.query('update post_job_checklists set employee_name=$1 where job_id=$2',['rewrite',job]),/immutable/)
    await assert.rejects(db.query('delete from post_job_checklists where job_id=$1',[job]),/immutable/)
    assert.equal((await rpc('get')).history.length,1)
  })
  await t.test('confirmed alias grants fieldwork completion without upstream stage changes; stale links fail',async()=>{
    await db.query('update external_object_mappings set connection_generation=$1',[id(31)])
    await assert.rejects(rpc('get',null,{jobId:id(12)}),/assigned/)
    await db.query('update external_object_mappings set connection_generation=$1',[generation])
    const result=await rpc('complete',{...valid(),customerHome:false,qualityCheck:true,reviewScanned:true,upcomingWorkNotes:'skip',frequencyAnswer:'skip'},{jobId:id(12)})
    assert.equal(result.statusManagedByServiceM8,true);assert.equal(result.job.status,'scheduled')
    assert.deepEqual(Object.keys(result.job.details),['postJobCompletedAt'])
    for(const key of ['qualityCheck','reviewScanned','askedUpcomingWork','askedFrequency'])assert.equal(result.checklist.responses[key],false)
    assert.equal(result.checklist.responses.upcomingWorkNotes,'')
    assert.equal((await db.query('select details from jobs where id=$1',[id(12)])).rows[0].details.serviceM8Status,'Work Order')
  })
  await t.test('job update failure rolls back the audit too',async()=>{
    await db.query('insert into jobs(id,business_id,assigned_to) values($1,$2,$3)',[id(13),'a',worker])
    await db.exec(`create function public.fail_completion() returns trigger language plpgsql as $$begin if new.id='${id(13)}' then raise exception 'simulated update failure'; end if; return new; end;$$;
      create trigger zz_test_failure before update on jobs for each row execute function fail_completion();`)
    await assert.rejects(rpc('complete',valid(),{jobId:id(13)}),/simulated update failure/)
    assert.equal((await rpc('get',null,{jobId:id(13)})).checklist,null)
    await db.exec('drop trigger zz_test_failure on jobs')
  })
  await t.test('double completion produces one immutable record; rejected sales/lost stages stay unchanged',async()=>{
    await db.query('insert into jobs(id,business_id,assigned_to) values($1,$2,$3)',[id(15),'a',worker])
    await db.exec('set role service_role')
    try {
      // PGlite serializes its single connection; the production RPC also
      // explicitly locks the job before checking/upserting the audit.
      const results=await Promise.all([1,2].map(()=>db.query('select post_job_checklist($1,$2,$3,$4,$5) result',['a',id(15),worker,'complete',JSON.stringify(valid())])))
      assert.deepEqual(results.map(r=>r.rows[0].result.alreadyCompleted),[false,true])
      assert.deepEqual(results[0].rows[0].result.checklist,results[1].rows[0].result.checklist)
    } finally {await db.exec('reset role')}
    for(const stage of ['new','quoted','cancelled']) {
      await db.query('update jobs set status=$1 where id=$2',[stage,id(13)])
      await assert.rejects(rpc('complete',valid(),{jobId:id(13)}),/accepted job/)
    }
    await db.query(`update jobs set status='scheduled' where id=$1`,[id(13)])
  })
  await t.test('RLS own-only employee reads, manager company reads; no direct audit/RPC writes',async()=>{
    await rpc('complete',valid(),{employee:owner})
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${worker}',false)`)
    try {
      assert.equal((await db.query('select * from post_job_checklists')).rows.length,3)
      await assert.rejects(db.query(`update post_job_checklists set employee_name='spoof'`),/permission denied/)
      await assert.rejects(db.query(`select post_job_checklist('a','${job}','${worker}','get')`),/permission denied/)
      await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false)`)
      assert.equal((await db.query('select * from post_job_checklists')).rows.length,4)
      await db.exec(`select set_config('request.jwt.claim.sub','${foreign}',false)`)
      assert.equal((await db.query('select * from post_job_checklists')).rows.length,0)
    } finally { await db.exec('reset role') }
  })
  await t.test('technicians cannot bypass via stage/details/insert/settings; disabled allows legacy flow',async()=>{
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${worker}',false)`)
    try {
      await assert.rejects(db.query(`update jobs set status='completed' where id=$1`,[id(13)]),/checklist/)
      await assert.rejects(db.query(`update jobs set details='{"jobStatus":"completed"}' where id=$1`,[id(13)]),/checklist/)
      await assert.rejects(db.query(`update jobs set details='{"postJobCompletedAt":"fake"}' where id=$1`,[id(13)]),/checklist/)
      await assert.rejects(db.query(`insert into jobs(id,business_id,status) values($1,'a','completed')`,[id(14)]),/checklist/)
      await assert.rejects(db.query(`update businesses set post_job_settings='{"enabled":false}' where id='a'`),/owner or manager/)
      await assert.rejects(db.query(`update jobs set assigned_to=$1 where id=$2`,[other,id(13)]),/assignment/)
      await db.query(`update jobs set status='completed' where id=$1`,[id(12)])
      assert.equal((await db.query('select status from jobs where id=$1',[id(12)])).rows[0].status,'scheduled')
      await assert.rejects(db.query(`update jobs set details=details||'{"jobStatus":"completed"}'::jsonb where id=$1`,[id(12)]),/checklist/)
      await db.query(`update jobs set details='{"jobStatus":"in_progress"}' where id=$1`,[id(13)])
    } finally { await db.exec('reset role') }
    await db.query(`update businesses set post_job_settings='{"enabled":false,"reviewUrl":""}' where id='a'`)
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${worker}',false)`)
    try { await db.query(`update jobs set status='completed',details='{"jobStatus":"completed"}' where id=$1`,[id(13)]) }
    finally { await db.exec('reset role') }
  })
  await t.test('null-profile display names use confirmed staff, unique email, then account email; audits keep accepted names',async()=>{
    const lookup=async(employee=worker,business='a')=>{
      await db.exec('set role service_role')
      try{return (await db.query('select post_job_employee_name($1,$2) name',[business,employee])).rows[0].name}
      finally{await db.exec('reset role')}
    }
    await db.query(`update users set name=null,email='shared@example.test' where id in ($1,$2)`,[worker,owner])
    await db.query(`insert into external_object_mappings values('a',$1,'staff',$2,$3,$4)`,[generation,'servicem8:'+remote,remote,JSON.stringify({name:'Luca Anderson',email:'shared@example.test'})])
    assert.equal(await lookup(),'Luca Anderson')
    assert.equal(await lookup(owner),'shared@example.test') // cannot borrow Luca via shared email
    await db.query(`update external_object_mappings set connection_generation=$1 where object_type='staff_identity'`,[id(31)])
    assert.equal(await lookup(),'shared@example.test') // ambiguous local mailbox, stale link
    await db.query(`update users set email='owner@example.test' where id=$1`,[owner])
    assert.equal(await lookup(),'Luca Anderson') // now a unique email DISPLAY match
    await assert.rejects(rpc('get',null,{jobId:id(12)}),/assigned/) // display match never authorizes
    await db.query(`insert into external_object_mappings values('a',$1,'staff',$2,$3,$4)`,[generation,'servicem8:'+id(21),id(21),JSON.stringify({name:'Another Luca',email:'shared@example.test'})])
    assert.equal(await lookup(),'shared@example.test') // ambiguous remote mailbox
    await db.query(`update external_object_mappings set connection_generation=$1 where object_type='staff_identity'`,[generation])
    assert.equal(await lookup(),'Luca Anderson') // confirmed link outranks ambiguous email
    await db.query(`insert into jobs(id,business_id,assigned_to) values($1,'a',$2)`,[id(16),worker])
    const result=await rpc('complete',{...valid(),employeeName:'Client spoof'},{jobId:id(16)})
    assert.equal(result.checklist.employeeName,'Luca Anderson')
    await db.query(`update external_object_mappings set snapshot=snapshot||'{"name":"Updated Luca"}'::jsonb where object_type='staff' and external_uuid=$1`,[remote])
    assert.equal(await lookup(),'Updated Luca')
    assert.equal((await rpc('complete',null,{jobId:id(16)})).checklist.employeeName,'Luca Anderson')
    await assert.rejects(lookup(worker,'b'),/Staff member not found/)
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${worker}',false)`)
    try{await assert.rejects(db.query(`select post_job_employee_name('a','${worker}')`),/permission denied/)}
    finally{await db.exec('reset role')}
  })
})
