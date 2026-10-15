-- Additive sales platform. Requires existing customers/jobs/quotes, public quote RPCs,
-- current_business_id(), users and activity_log. Run in a staging project first.
-- Prerequisite: backend/supabase/schema-servicem8.sql, unchanged (canonical
-- connection fields and legacy integration tables must already exist).
begin;
create table if not exists public.sales_settings (
 business_id text primary key, pipeline jsonb not null default '[]', probabilities jsonb not null default '{}',
 followup_days integer not null default 2 check(followup_days between 1 and 365), updated_at timestamptz not null default now()
);
create table if not exists public.sales_goals (
 id uuid primary key default gen_random_uuid(), business_id text not null, label text not null,
 metric text not null check(metric in ('revenue','leads','quotes','conversion','margin')), target numeric not null check(target>0),
 starts_at timestamptz not null, ends_at timestamptz not null, salesperson_id uuid, reward text,
 created_at timestamptz not null default now(), check(ends_at>starts_at)
);
create index if not exists sales_goals_business_dates on public.sales_goals(business_id,starts_at,ends_at);
create table if not exists public.sales_spend (
 id uuid primary key default gen_random_uuid(), business_id text not null, source text not null,
 campaign text, amount numeric not null check(amount>=0), spent_at date not null, created_at timestamptz not null default now()
);
create index if not exists sales_spend_business_date on public.sales_spend(business_id,spent_at);
create table if not exists public.sales_events (
 id uuid primary key default gen_random_uuid(), business_id text not null, job_id uuid not null references public.jobs(id),
 kind text not null, detail jsonb not null default '{}', created_at timestamptz not null default now()
);
create index if not exists sales_events_business_job_time on public.sales_events(business_id,job_id,created_at);
create table if not exists public.quote_versions (
 id uuid primary key default gen_random_uuid(), business_id text not null, quote_id uuid not null references public.quotes(id),
 fingerprint text not null, snapshot jsonb not null, created_at timestamptz not null default now(), unique(quote_id,fingerprint)
);
create index if not exists quote_versions_business_quote on public.quote_versions(business_id,quote_id,created_at desc);
alter table public.servicem8_connections add column if not exists auto_handoff boolean not null default false;
alter table public.servicem8_connections add column if not exists last_sync_at timestamptz;
alter table public.servicem8_connections add column if not exists last_error text;
alter table public.servicem8_connections add column if not exists lease_until timestamptz;
alter table public.servicem8_connections add column if not exists generation uuid not null default gen_random_uuid();
alter table public.servicem8_connections add column if not exists webhook_enc text;
-- No browser access to credentials or webhook hashes. A backend status endpoint returns a safe projection.
create table if not exists public.integration_tasks (
 id uuid primary key default gen_random_uuid(), business_id text not null, kind text not null check(kind in ('handoff','webhook','refresh_job','reminder')),
 dedupe_key text not null, payload jsonb not null, state text not null default 'pending' check(state in ('pending','running','succeeded','failed')),
 attempts integer not null default 0, next_attempt_at timestamptz not null default now(), lease_until timestamptz, lease_token uuid,
 last_error text, created_at timestamptz not null default now(), completed_at timestamptz, unique(business_id,kind,dedupe_key)
);
create index if not exists integration_tasks_due on public.integration_tasks(state,next_attempt_at);
create table if not exists public.external_object_mappings (
 business_id text not null, connection_generation uuid not null, object_type text not null,
 local_id text not null, external_uuid uuid not null, snapshot jsonb, synced_at timestamptz,
 primary key(business_id,connection_generation,object_type,local_id), unique(business_id,connection_generation,object_type,external_uuid)
);
create table if not exists public.integration_oauth_states (
 digest text primary key, browser_hash text not null, business_id text not null, user_id uuid not null, expires_at timestamptz not null, created_at timestamptz not null default now()
);
-- Enable RLS explicitly even if project defaults change.
do $$ declare t text; begin
 foreach t in array array['sales_settings','sales_goals','sales_spend','sales_events','quote_versions','servicem8_connections','integration_tasks','external_object_mappings','integration_oauth_states','servicem8_handoffs','servicem8_object_map','servicem8_webhook_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public, anon, authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
 foreach t in array array['sales_settings','sales_goals','sales_spend'] loop
  execute format('grant select,insert,update,delete on public.%I to authenticated',t);
  execute format('drop policy if exists sales_tenant on public.%I',t);
  execute format('create policy sales_tenant on public.%I for all to authenticated using (business_id=(select public.current_business_id())) with check (business_id=(select public.current_business_id()))',t);
 end loop;
 foreach t in array array['sales_events','quote_versions'] loop
  execute format('grant select on public.%I to authenticated',t);
  execute format('drop policy if exists sales_tenant_read on public.%I',t);
  execute format('create policy sales_tenant_read on public.%I for select to authenticated using (business_id=(select public.current_business_id()))',t);
 end loop;
end $$;
-- Worker claims are atomic across Render instances, fenced with a fresh lease token.
create or replace function public.claim_integration_task()
returns setof public.integration_tasks language sql security definer set search_path=public as $$
 update public.integration_tasks set state='running',attempts=attempts+1,lease_until=now()+interval '5 minutes',lease_token=gen_random_uuid()
 where id=(select id from public.integration_tasks where ((state in ('pending','failed') and next_attempt_at<=now()) or (state='running' and lease_until<now())) and attempts<12 order by created_at for update skip locked limit 1) returning *;
$$;
revoke all on function public.claim_integration_task() from public,anon,authenticated;
grant execute on function public.claim_integration_task() to service_role;
create or replace function public.sales_job_audit()
returns trigger language plpgsql security definer set search_path=public as $$
declare q public.quotes; snap jsonb; changed boolean; begin
 if new.quote_id is not null then select * into q from public.quotes where id::text=new.quote_id and business_id=new.business_id for update nowait; end if;
 if tg_op='UPDATE' and exists(select 1 from public.quotes where id::text=old.quote_id and status='accepted') then
  if new.quote_id is distinct from old.quote_id or new.business_id is distinct from old.business_id or new.customer_id is distinct from old.customer_id then raise exception 'Accepted quote is locked'; end if;
  if (coalesce(old.details,'{}')-'salesHistory'-'nextFollowUpAt') is distinct from (coalesce(new.details,'{}')-'salesHistory'-'nextFollowUpAt') then
   -- Freeze only commercial fields. Contacts and sales notes can still be maintained.
   if old.details->'services' is distinct from new.details->'services' or old.details->'total' is distinct from new.details->'total'
      or old.details->'areaPolys' is distinct from new.details->'areaPolys' or old.details->'mapCenter' is distinct from new.details->'mapCenter'
      or old.details->'estimatedCost' is distinct from new.details->'estimatedCost'
      or old.details->'estimatedMarginPct' is distinct from new.details->'estimatedMarginPct'
      or old.details->'gstRegistered' is distinct from new.details->'gstRegistered'
      or old.details->'targetMargin' is distinct from new.details->'targetMargin' then
    raise exception 'Accepted quote is locked. Create a new opportunity for additional work.';
   end if;
  end if;
 end if;
 changed:=tg_op='INSERT';
 if tg_op='UPDATE' then changed:=old.status is distinct from new.status; end if;
 if changed then
  insert into public.sales_events(business_id,job_id,kind,detail) values(new.business_id,new.id,'stage_changed',jsonb_build_object('to',new.status));
 end if;
 if q.id is not null and q.status<>'accepted' then
  snap:=jsonb_build_object('amount',q.amount,'details',new.details,
   'customer',(select to_jsonb(c) from public.customers c where c.id=new.customer_id and c.business_id=new.business_id),
   'business',(select to_jsonb(b) from public.businesses b where b.id=new.business_id));
  insert into public.quote_versions(business_id,quote_id,fingerprint,snapshot) values(new.business_id,q.id,md5(snap::text),snap) on conflict do nothing;
 end if;
 if new.status='won' and exists(select 1 from public.servicem8_connections where business_id=new.business_id and auto_handoff) then
  insert into public.integration_tasks(business_id,kind,dedupe_key,payload) values(new.business_id,'handoff',new.id::text,jsonb_build_object('jobId',new.id)) on conflict do nothing;
 end if;
 return new;
end $$;
revoke all on function public.sales_job_audit() from public,anon,authenticated;
drop trigger if exists sales_job_audit on public.jobs;
create trigger sales_job_audit after insert or update on public.jobs for each row execute function public.sales_job_audit();
create or replace function public.sales_quote_guard()
returns trigger language plpgsql security definer set search_path=public as $$
declare j public.jobs; snap jsonb; begin
 if new.lead_id is not null and not exists(select 1 from public.customers where id::text=new.lead_id and business_id=new.business_id) then raise exception 'Customer does not belong to this business'; end if;
 if exists(select 1 from public.jobs where quote_id=new.id::text and (business_id is distinct from new.business_id or customer_id::text is distinct from new.lead_id)) then raise exception 'Quote customer and business must match linked jobs'; end if;
 if tg_op='UPDATE' and new.business_id is distinct from old.business_id and exists(select 1 from public.quote_versions where quote_id=old.id) then raise exception 'Versioned quote business is immutable'; end if;
 if old.status='accepted' and (new.business_id is distinct from old.business_id or new.amount is distinct from old.amount or new.status is distinct from old.status or new.lead_id is distinct from old.lead_id or new.public_token is distinct from old.public_token or new.created_at is distinct from old.created_at or new.id is distinct from old.id) then
  raise exception 'Accepted quotes are immutable';
 end if;
 if new.status='accepted' and old.status is distinct from 'accepted' then
  select * into j from public.jobs where quote_id=new.id::text and business_id=new.business_id order by id limit 1 for update;
  if j.id is null then raise exception 'Approval requires a linked job'; end if;
  if j.id is not null then
   snap:=jsonb_build_object('accepted',true,'approvedAt',extract(epoch from now())*1000,'amount',new.amount,'details',j.details,'customer',(select to_jsonb(c) from public.customers c where c.id=j.customer_id and c.business_id=new.business_id),'business',(select to_jsonb(b) from public.businesses b where b.id=new.business_id));
   insert into public.quote_versions(business_id,quote_id,fingerprint,snapshot) values(new.business_id,new.id,md5(snap::text),snap) on conflict do nothing;
   -- Approval may happen after scheduling/completion, without changing the
   -- operational job status. Use the same dedupe key as the job Won hook.
   if exists(select 1 from public.servicem8_connections where business_id=new.business_id and auto_handoff) then
    insert into public.integration_tasks(business_id,kind,dedupe_key,payload)
     values(new.business_id,'handoff',j.id::text,jsonb_build_object('jobId',j.id))
     on conflict (business_id,kind,dedupe_key) do nothing;
   end if;
  end if;
 end if;
 return new;
end $$;
revoke all on function public.sales_quote_guard() from public,anon,authenticated;
drop trigger if exists sales_quote_guard on public.quotes;
create trigger sales_quote_guard before insert or update on public.quotes for each row execute function public.sales_quote_guard();


create or replace function public.respond_to_public_quote(p_token uuid, p_action text, p_message text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  q record;
  j_id uuid;
  j_status text;
begin
  if p_action is null or p_action not in ('accept','decline','question') then
    raise exception 'invalid action';
  end if;

  select * into q from public.quotes where public_token = p_token for update;
  if q.id is null then
    return jsonb_build_object('error','not_found');
  end if;

  if q.status='accepted' then return jsonb_build_object('ok',true,'status','accepted'); end if;
  if p_action='accept' and q.created_at+interval '30 days'<now() then return jsonb_build_object('error','expired'); end if;
  if length(coalesce(p_message,''))>4000 then raise exception 'message too long'; end if;

  select id, status into j_id, j_status from public.jobs where quote_id = q.id::text and business_id=q.business_id order by id limit 1 for update;

  if q.lead_id is not null and not exists(select 1 from public.customers where id::text=q.lead_id and business_id=q.business_id) then raise exception 'Customer does not belong to this business'; end if;

  if p_action = 'accept' then
    update public.quotes set status = 'accepted' where id = q.id;
    -- Never downgrade a job that's already progressed past "won" (e.g.
    -- already scheduled/completed) — this only ever moves a job forward.
    if j_id is not null then
      update public.jobs set status = case when j_status in ('won','scheduled','completed','paid') then j_status else 'won' end where id = j_id and business_id=q.business_id;
    end if;
  elsif p_action = 'decline' then
    update public.quotes set status = 'declined' where id = q.id;
  end if;

  if q.lead_id is not null then
    insert into public.activity_log (business_id, customer_id, job_id, type, summary, detail)
    values (
      q.business_id, q.lead_id::uuid, j_id,
      case p_action when 'accept' then 'quote_accepted' when 'decline' then 'quote_declined' else 'note' end,
      case p_action
        when 'accept' then 'Customer approved their quote online.'
        when 'decline' then 'Customer declined their quote online.'
        else 'Customer asked a question about their quote: "'||coalesce(p_message,'')||'"'
      end,
      case when p_message is not null then jsonb_build_object('message', p_message) else null end
    );
  end if;

  return jsonb_build_object('ok', true, 'status', case p_action when 'accept' then 'accepted' when 'decline' then 'declined' else q.status end);
end;
$$;
revoke all on function public.respond_to_public_quote(uuid,text,text) from public;
grant execute on function public.respond_to_public_quote(uuid,text,text) to anon, authenticated;



-- Job row triggers run after PostgreSQL has locked the job. Quote approval
-- locks quote then job, so these triggers must NOT wait on a competing quote
-- lock: NOWAIT aborts with retryable SQLSTATE 55P03 instead of a lock cycle.
-- Callers must retry the whole transaction after lock contention.
-- Canonical event timestamps are assigned on transitions, never reload time.
create or replace function public.sales_job_prepare()
returns trigger language plpgsql security definer set search_path=public as $$
declare q public.quotes; k text; approval_stamp jsonb; stamp jsonb:=to_jsonb(extract(epoch from now())*1000); begin
 new.details:=coalesce(new.details,'{}');
 if new.customer_id is not null and not exists(select 1 from public.customers where id=new.customer_id and business_id=new.business_id) then raise exception 'Customer does not belong to this business'; end if;
 if new.quote_id is not null then
  select * into q from public.quotes where id::text=new.quote_id and business_id=new.business_id for update nowait;
  if q.id is null then raise exception 'Quote does not belong to this business'; end if;
  if q.lead_id is distinct from new.customer_id::text then raise exception 'Quote customer must match job customer'; end if;
  if q.status='accepted' and (tg_op='INSERT' or old.quote_id is distinct from new.quote_id) then raise exception 'Accepted quote is locked'; end if;
 end if;
 foreach k in array array['wonAt','approvedAt','firstResponseAt','qualifiedAt'] loop
  new.details:=new.details-k;
  if tg_op='UPDATE' and old.details->k is not null and old.details->k <> 'null'::jsonb then new.details:=new.details||jsonb_build_object(k,old.details->k); end if;
 end loop;
 -- Missing legacy won dates are unknown history, not revenue earned today.
 -- Stamp only a newly inserted win or an actual transition into won stages.
 if new.status in ('won','scheduled','completed','paid')
    and (tg_op='INSERT' or old.status is null or old.status not in ('won','scheduled','completed','paid'))
    and not (new.details ? 'wonAt') then
  new.details:=new.details||jsonb_build_object('wonAt',stamp);
 end if;
 -- Only an actual quote-acceptance transition creates this immutable marker.
 -- Legacy accepted quotes without it retain their unknown approval date.
 if q.status='accepted' and not (new.details ? 'approvedAt') then
  select snapshot->'approvedAt' into approval_stamp from public.quote_versions
   where quote_id=q.id and business_id=new.business_id and snapshot->>'accepted'='true'
     and jsonb_typeof(snapshot->'approvedAt')='number'
   order by created_at,id limit 1;
  if approval_stamp is not null then new.details:=new.details||jsonb_build_object('approvedAt',approval_stamp); end if;
 end if;
 if new.status in ('contacted','qualified','quoting','quoted','followup','won','scheduled','completed','paid')
    and (tg_op='INSERT' or old.status is null or old.status='new') and not (new.details ? 'firstResponseAt') then new.details:=new.details||jsonb_build_object('firstResponseAt',stamp); end if;
 if new.status='qualified' and (tg_op='INSERT' or old.status is distinct from new.status) and not (new.details ? 'qualifiedAt') then new.details:=new.details||jsonb_build_object('qualifiedAt',stamp); end if;
 return new;
end $$;
revoke all on function public.sales_job_prepare() from public,anon,authenticated;
drop trigger if exists sales_job_prepare on public.jobs;
create trigger sales_job_prepare before insert or update on public.jobs for each row execute function public.sales_job_prepare();

-- Keep the live branding fields. For approved quotes, render commercial data
-- from the immutable snapshot, using an explicit public-field allowlist.
create or replace function public.get_public_quote(p_token uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare q public.quotes; j public.jobs; c jsonb; b jsonb; d jsonb; frozen jsonb; services jsonb; begin
 select * into q from public.quotes where public_token=p_token;
 if q.id is null then return jsonb_build_object('error','not_found'); end if;
 select * into j from public.jobs where quote_id=q.id::text and business_id=q.business_id order by id limit 1;
 select to_jsonb(x) into c from public.customers x where x.id::text=q.lead_id and x.business_id=q.business_id;
 select to_jsonb(x) into b from public.businesses x where x.id=q.business_id;
 d:=coalesce(j.details,'{}');
 if q.status='accepted' then
  select snapshot into frozen from public.quote_versions where quote_id=q.id and business_id=q.business_id order by (snapshot->>'accepted'='true') desc nulls last, created_at desc, id desc limit 1;
  d:=coalesce(frozen->'details',d);c:=coalesce(frozen->'customer',c);b:=coalesce(frozen->'business',b);
 end if;
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
  'svc',e->'svc','qty',e->'qty','roofType',e->'roofType','storeys',e->'storeys','sides',e->'sides','customRate',e->'customRate',
  'fixedPrice',coalesce(e->'priceSnapshot',e->'fixedPrice')))),'[]') into services from jsonb_array_elements(coalesce(d->'services','[]')) e;
 return jsonb_build_object('quoteId',q.id,'quoteNumber','Q-'||upper(right(q.id::text,6)),'status',q.status,'amount',q.amount,'createdAt',q.created_at,
 'validUntil',q.created_at+interval '30 days','estimatedDurationMin',d->>'estimatedDurationMin',
 'customer',jsonb_build_object('name',c->>'name','address',c->>'address','suburb',c->>'suburb'),
 'business',jsonb_build_object('name',coalesce(b->>'name','Your service provider'),'phone',b->>'phone','email',b->>'email','logoUrl',b->>'logo_url','accentColor',b->>'accent_color',
 'primaryColor',b->>'primary_color','fontStyle',b->>'font_style','headerStyle',b->>'header_style','quoteIntroMessage',b->>'quote_intro_message','policies',b->'policies_config'),
 'services',services,'notes',coalesce(d->>'jobNotes',d->>'notes'),'jobStatus',j.status,'areaPolys',coalesce(d->'areaPolys','[]'),'mapCenter',d->'mapCenter');
end $$;
revoke all on function public.get_public_quote(uuid) from public;
grant execute on function public.get_public_quote(uuid) to anon,authenticated;
-- Audit versions cannot be rewritten, even by service-role application code.
create or replace function public.sales_version_guard()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_op <> 'INSERT' then raise exception 'Quote versions are append-only'; end if;
 if not exists(select 1 from public.quotes where id=new.quote_id and business_id=new.business_id) then raise exception 'Quote does not belong to this business'; end if;
 if exists(select 1 from public.quotes where id=new.quote_id and status='accepted') then raise exception 'Accepted quote versions are frozen'; end if;
 new.created_at:=now();
 return new;
end $$;
revoke all on function public.sales_version_guard() from public,anon,authenticated;
drop trigger if exists sales_version_guard on public.quote_versions;
create trigger sales_version_guard before insert or update or delete on public.quote_versions for each row execute function public.sales_version_guard();
commit;
