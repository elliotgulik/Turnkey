const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
let db;
const migration=fs.readFileSync('supabase/migrations/20261018101447_crm_security_hardening.sql','utf8');
const uid='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
before(async()=>{
  const {PGlite}=await import('@electric-sql/pglite');db=new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;
    create table users(id uuid primary key,business_id text,role text,email text,name text,phone text,last_seen_at timestamptz,created_at timestamptz default now());
    create function current_business_id() returns text language sql stable security definer set search_path=public as $$select business_id from users where id=auth.uid()$$;
    create function current_business_role() returns text language sql stable security definer set search_path=public as $$select role from users where id=auth.uid()$$;
    create table businesses(id text primary key,name text,phone text,email text,region text,logo_url text,accent_color text,primary_color text,font_style text,policies_config jsonb,pricing_config jsonb,home_address text);
    create table quotes(id uuid primary key,business_id text,public_token uuid,status text,amount numeric);
    create table jobs(id uuid primary key,business_id text);
    create table customers(id uuid primary key,business_id text);
    create table invoices(id uuid primary key,business_id text);
    create table import_batches(id uuid primary key,business_id text,status text,undone_at timestamptz,undone_by uuid);
    create table import_records(batch_id uuid,business_id text,entity_id uuid,entity_type text);
    create function get_public_quote(p_token uuid) returns jsonb language sql security definer set search_path=public as $$select jsonb_build_object('status',status,'amount',amount) from quotes where public_token=p_token$$;
    create function respond_to_public_quote(p_token uuid,p_action text,p_message text default null) returns jsonb language plpgsql security definer set search_path=public as $$begin update quotes set status='accepted' where public_token=p_token;return get_public_quote(p_token);end$$;
    create function run_import(p_source text,p_customers jsonb default '[]',p_jobs jsonb default '[]',p_quotes jsonb default '[]',p_invoices jsonb default '[]') returns jsonb language plpgsql security definer set search_path=public as $$begin if auth.uid() is null then raise exception 'Sign in';end if;return jsonb_build_object('business',current_business_id());end$$;
    create function undo_import(p_batch_id uuid) returns jsonb language sql security definer set search_path=public as $$select '{}'::jsonb$$;
    create function set_staff_role(target_id uuid,new_role text) returns void language plpgsql security definer set search_path=public as $$begin if current_business_role() is distinct from 'owner' then raise exception 'Only owner';end if;update users set role=new_role where id=target_id and business_id=current_business_id();end$$;
    create table auth.users(id uuid,email text);
    create function handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$begin insert into users(id,business_id,role,email) values(new.id,new.id::text,'owner',new.email);return new;end$$;
    create trigger on_signup after insert on auth.users for each row execute function handle_new_user();
    create function set_updated_at() returns trigger language plpgsql as $$begin return new;end$$;
    create table email_accounts(id uuid,business_id text,user_id uuid,provider text,email_address text,last_sync_at timestamptz,created_at timestamptz,access_token_enc text,refresh_token_enc text);
    create table calendar_connections(id uuid,business_id text,user_id uuid,provider text,ical_url text,sync_status text,sync_error text,last_synced_at timestamptz,created_at timestamptz,encrypted_tokens text);
    create view email_accounts_status with(security_invoker=true) as select id,business_id,user_id,provider,email_address,last_sync_at,created_at from email_accounts;
    create view calendar_connections_status with(security_invoker=true) as select id,business_id,user_id,provider,ical_url,sync_status,sync_error,last_synced_at,created_at from calendar_connections;
    insert into users(id,business_id,role) values('${uid}','a','owner'),('${other}','b','technician');
    insert into businesses(id,name,pricing_config,home_address) values('a','Business A','{"rates":{"driveway":4},"costInputs":{"wages":42},"targetMargin":0.65}','Private home'),('b','Business B','{}','Other home');
    insert into quotes values('20000000-0000-4000-8000-000000000001','a','30000000-0000-4000-8000-000000000001','sent',115);
    insert into email_accounts(id,business_id,user_id,provider,email_address,access_token_enc) values(gen_random_uuid(),'a','${uid}','gmail','owner@example.test','private-token');
    insert into email_accounts(id,business_id,user_id,provider,email_address,access_token_enc) values(gen_random_uuid(),'b','${other}','gmail','other@example.test','other-token');
    insert into calendar_connections(id,business_id,user_id,provider,sync_status,encrypted_tokens) values(gen_random_uuid(),'a','${uid}','google','ok','private-calendar-token');
    alter table users enable row level security;
    alter table businesses enable row level security;
    create policy "public read" on businesses for select using(true);
    alter table email_accounts enable row level security;
    alter table calendar_connections enable row level security;
    create policy tenant on email_accounts for select using(business_id=current_business_id());
    create policy tenant on calendar_connections for select using(business_id=current_business_id());
  `);
  for(const table of ['crm_state','equipment_assets','equipment_service_events','equipment_usage','external_object_mappings','integration_oauth_states','integration_tasks','job_work_logs','lead_sources','leads','marketing_ad_connections','marketing_attribution_links','marketing_daily_snapshots','overdue_push_log','servicem8_connections','servicem8_handoffs','servicem8_object_map','servicem8_webhook_events']){
    await db.exec(`create table ${table}(id uuid primary key default gen_random_uuid(),business_id text,secret text);alter table ${table} enable row level security;insert into ${table}(business_id,secret) values('a','private');`);
  }
  await db.exec('grant all on all tables in schema public to anon,authenticated,service_role;grant all on all functions in schema public to anon,authenticated,service_role;');
  await db.exec(migration);await db.exec(migration);
});
after(async()=>await db?.close());
async function as(role,user,query,params=[]){
  await db.exec(`set role ${role};`);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user||'']);
  try{return await db.query(query,params);}finally{await db.exec('reset role');}
}
test('public booking projection works anonymously, but raw internal pricing and homes cannot be read',async()=>{
  const {rows}=await as('anon',null,"select get_public_business('a') as b");
  assert.equal(rows[0].b.name,'Business A');assert.equal(rows[0].b.rates.driveway,4);
  assert.doesNotMatch(JSON.stringify(rows[0]),/costInputs|wages|targetMargin|Private home/);
  await assert.rejects(as('anon',null,'select * from businesses'),/permission denied/);
  const own=await as('authenticated',uid,'select id,pricing_config from businesses');assert.deepEqual(own.rows.map(r=>r.id),['a']);
});
test('connection status views work with RLS while token columns stay private',async()=>{
  const rows=await as('authenticated',uid,'select * from email_accounts_status');assert.equal(rows.rows.length,1);assert.equal(rows.rows[0].email_address,'owner@example.test');
  assert.equal((await as('authenticated',uid,'select * from calendar_connections_status')).rows.length,1);
  await assert.rejects(as('authenticated',uid,'select access_token_enc from email_accounts'),/permission denied/);
  await assert.rejects(as('authenticated',uid,'select encrypted_tokens from calendar_connections'),/permission denied/);
});
test('public quote reading and acceptance retain signatures and operate through invoker wrappers',async()=>{
  const token='30000000-0000-4000-8000-000000000001';
  const original=await as('anon',null,'select get_public_quote($1) as q',[token]);assert.equal(original.rows[0].q.amount,115);
  const accepted=await as('anon',null,"select respond_to_public_quote($1,'accept') as q",[token]);assert.equal(accepted.rows[0].q.status,'accepted');
  const f=await db.query("select prosecdef from pg_proc where oid='public.get_public_quote(uuid)'::regprocedure");assert.equal(f.rows[0].prosecdef,false);
  await assert.rejects(as('anon',null,"select run_import('csv')"),/permission denied/);
  await assert.rejects(as('anon',null,"select turnkey_private.run_import('csv')"),/permission denied/);
});
test('role and tenant columns cannot be updated directly, while safe profile fields remain editable',async()=>{
  await assert.rejects(as('authenticated',other,"update users set role='owner' where id=$1",[other]),/permission denied/);
  await assert.rejects(as('authenticated',other,"update users set business_id='a' where id=$1",[other]),/permission denied/);
  await as('authenticated',other,"update users set name='Updated',last_seen_at=now() where id=$1",[other]);
  assert.equal((await as('authenticated',other,'select name from users where id=$1',[other])).rows[0].name,'Updated');
});
test('backend tables deny browser roles, allow the trusted backend and expose no policy-free table',async()=>{
  for(const table of ['lead_sources','leads','crm_state','servicem8_connections','job_work_logs','marketing_ad_connections']){
    await assert.rejects(as('authenticated',uid,`select * from ${table}`),/permission denied/);
    assert.equal((await as('service_role',null,`select * from ${table}`)).rows.length,1);
  }
  const grants=await db.query("select has_table_privilege('anon','users','TRUNCATE') as anon,has_table_privilege('authenticated','users','TRUNCATE') as signed");assert.deepEqual(grants.rows[0],{anon:false,signed:false});
});
test('signup trigger still works after its privileged implementation moves schema',async()=>{
  const id='10000000-0000-4000-8000-000000000003';await db.query('insert into auth.users values($1,$2)',[id,'signup@example.test']);
  assert.equal((await db.query('select business_id from users where id=$1',[id])).rows[0].business_id,id);
  const f=await db.query("select proconfig from pg_proc where oid='public.set_updated_at()'::regprocedure");assert.ok(f.rows[0].proconfig.some(x=>x.startsWith('search_path=')));
});
test('undo import rejects missing identities and foreign batches without modifying them',async()=>{
  const batch='40000000-0000-4000-8000-000000000001';await db.query("insert into import_batches values($1,'a','completed',null,null)",[batch]);
  await assert.rejects(as('authenticated',null,'select undo_import($1)',[batch]),/owner or manager/);
  await assert.rejects(as('authenticated',other,'select undo_import($1)',[batch]),/owner or manager/);
  await db.query("update users set role='owner' where id=$1",[other]);
  await assert.rejects(as('authenticated',other,'select undo_import($1)',[batch]),/not found/);
  assert.equal((await db.query('select status from import_batches where id=$1',[batch])).rows[0].status,'completed');
  const own=await as('authenticated',uid,'select undo_import($1) as result',[batch]);assert.equal(own.rows[0].result.rows_deleted,0);assert.equal(own.rows[0].result.status,'undone');
});
