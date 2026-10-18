-- Keep privileged implementations outside the exposed Data API schema.
-- Public RPC names/signatures stay stable; wrappers run as the caller.
-- No application records are deleted or rewritten by this migration.
create schema if not exists turnkey_private;
revoke all on schema turnkey_private from public;
grant usage on schema turnkey_private to anon, authenticated, service_role;
alter default privileges in schema turnkey_private revoke execute on functions from public;

do $migrate$
declare
  f record;
  current_oid oid;
begin
  for f in select * from (values
    ('current_business_id()', 'current_business_id()', 'text', 'stable', 'select turnkey_private.current_business_id()', 'anon, authenticated, service_role'),
    ('current_business_role()', 'current_business_role()', 'text', 'stable', 'select turnkey_private.current_business_role()', 'anon, authenticated, service_role'),
    ('get_public_quote(uuid)', 'get_public_quote(p_token uuid)', 'jsonb', 'volatile', 'select turnkey_private.get_public_quote(p_token)', 'anon, authenticated, service_role'),
    ('respond_to_public_quote(uuid,text,text)', 'respond_to_public_quote(p_token uuid, p_action text, p_message text default null)', 'jsonb', 'volatile', 'select turnkey_private.respond_to_public_quote(p_token,p_action,p_message)', 'anon, authenticated, service_role'),
    ('run_import(text,jsonb,jsonb,jsonb,jsonb)', 'run_import(p_source text, p_customers jsonb default ''[]''::jsonb, p_jobs jsonb default ''[]''::jsonb, p_quotes jsonb default ''[]''::jsonb, p_invoices jsonb default ''[]''::jsonb)', 'jsonb', 'volatile', 'select turnkey_private.run_import(p_source,p_customers,p_jobs,p_quotes,p_invoices)', 'authenticated, service_role'),
    ('undo_import(uuid)', 'undo_import(p_batch_id uuid)', 'jsonb', 'volatile', 'select turnkey_private.undo_import(p_batch_id)', 'authenticated, service_role'),
    ('set_staff_role(uuid,text)', 'set_staff_role(target_id uuid, new_role text)', 'void', 'volatile', 'select turnkey_private.set_staff_role(target_id,new_role)', 'authenticated, service_role')
  ) as x(signature, declaration, returns_type, volatility, body, allowed_roles)
  loop
    current_oid := to_regprocedure('public.' || f.signature);
    if current_oid is not null and (select prosecdef from pg_proc where oid=current_oid) then
      if to_regprocedure('turnkey_private.' || f.signature) is not null then
        raise exception 'Conflicting privileged implementation for %', f.signature;
      end if;
      execute format('alter function public.%s set schema turnkey_private', f.signature);
    end if;
    if to_regprocedure('turnkey_private.' || f.signature) is not null then
      execute format('revoke all on function turnkey_private.%s from public, anon, authenticated', f.signature);
      execute format('grant execute on function turnkey_private.%s to %s', f.signature, f.allowed_roles);
      execute format('create or replace function public.%s returns %s language sql security invoker %s set search_path=pg_catalog,public as %L', f.declaration, f.returns_type, f.volatility, f.body);
      execute format('revoke all on function public.%s from public, anon, authenticated', f.signature);
      execute format('grant execute on function public.%s to %s', f.signature, f.allowed_roles);
    end if;
  end loop;

  -- Trigger dependencies follow the function OID when its schema moves.
  if to_regprocedure('public.handle_new_user()') is not null then
    alter function public.handle_new_user() set schema turnkey_private;
  end if;
  if to_regprocedure('turnkey_private.handle_new_user()') is not null then
    revoke all on function turnkey_private.handle_new_user() from public, anon, authenticated;
    grant execute on function turnkey_private.handle_new_user() to service_role;
  end if;
  if to_regprocedure('public.set_updated_at()') is not null then
    alter function public.set_updated_at() set search_path=pg_catalog,public;
    revoke all on function public.set_updated_at() from public, anon, authenticated;
  end if;
end;
$migrate$;

-- Explicitly reject missing identities/roles. SQL NULL must never make an
-- ownership check pass or mark a foreign import batch as undone.
create or replace function turnkey_private.undo_import(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare
  biz text := public.current_business_id();
  caller_role text := public.current_business_role();
  batch_status text;
  rec record;
  affected int;
  n_deleted int := 0;
begin
  if auth.uid() is null or biz is null or caller_role is null or caller_role not in ('owner','manager') then
    raise exception 'Only an owner or manager can undo an import' using errcode='42501';
  end if;
  select status into batch_status from public.import_batches
    where id=p_batch_id and business_id=biz for update;
  if not found then raise exception 'Import batch not found for this business' using errcode='42501'; end if;
  if batch_status='undone' then raise exception 'This import was already undone'; end if;
  for rec in select entity_id,entity_type from public.import_records
    where batch_id=p_batch_id and business_id=biz
    order by case entity_type when 'invoice' then 1 when 'quote' then 2 when 'job' then 3 when 'customer' then 4 else 5 end
  loop
    case rec.entity_type
      when 'invoice' then delete from public.invoices where id=rec.entity_id and business_id=biz;
      when 'quote' then delete from public.quotes where id=rec.entity_id and business_id=biz;
      when 'job' then delete from public.jobs where id=rec.entity_id and business_id=biz;
      when 'customer' then delete from public.customers where id=rec.entity_id and business_id=biz;
      else continue;
    end case;
    get diagnostics affected = row_count;
    n_deleted := n_deleted + affected;
  end loop;
  update public.import_batches set status='undone',undone_at=now(),undone_by=auth.uid()
    where id=p_batch_id and business_id=biz;
  return jsonb_build_object('batch_id',p_batch_id,'status','undone','rows_deleted',n_deleted);
end;
$function$;
revoke all on function turnkey_private.undo_import(uuid) from public, anon, authenticated;
grant execute on function turnkey_private.undo_import(uuid) to authenticated, service_role;

-- Booking needs public branding/rates, never wages, margins, costs, home
-- address or the rest of the internal pricing configuration.
create or replace function turnkey_private.get_public_business(p_business_id text)
returns jsonb language sql stable security definer set search_path=pg_catalog,public
as $function$
  select jsonb_build_object('name',name,'phone',phone,'email',email,'region',region,
    'logo_url',logo_url,'accent_color',accent_color,'primary_color',primary_color,
    'font_style',font_style,'policies_config',policies_config,
    'rates',pricing_config->'rates')
  from public.businesses where id=p_business_id;
$function$;
revoke all on function turnkey_private.get_public_business(text) from public, anon, authenticated;
grant execute on function turnkey_private.get_public_business(text) to anon, authenticated, service_role;
create or replace function public.get_public_business(p_business_id text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public
as $function$ select turnkey_private.get_public_business(p_business_id); $function$;
revoke all on function public.get_public_business(text) from public, anon, authenticated;
grant execute on function public.get_public_business(text) to anon, authenticated, service_role;

-- Data API roles have no need for DDL-like table privileges. RLS does not
-- protect TRUNCATE; revoke it even on tables whose row policies are sound.
do $grants$
declare t record; columns_list text;
begin
  for t in select tablename from pg_tables where schemaname='public' loop
    execute format('revoke truncate, trigger, references on table public.%I from public, anon, authenticated',t.tablename);
  end loop;
  for t in select unnest(array['crm_state','equipment_assets','equipment_service_events','equipment_usage',
    'external_object_mappings','integration_oauth_states','integration_tasks','job_work_logs','lead_sources','leads',
    'marketing_ad_connections','marketing_attribution_links','marketing_daily_snapshots','overdue_push_log',
    'servicem8_connections','servicem8_handoffs','servicem8_object_map','servicem8_webhook_events']) as tablename
  loop
    if to_regclass('public.'||t.tablename) is null then continue; end if;
    execute format('alter table public.%I enable row level security',t.tablename);
    execute format('revoke all on table public.%I from public, anon, authenticated',t.tablename);
    select string_agg(format('%I',attname),',') into columns_list from pg_attribute
      where attrelid=to_regclass('public.'||t.tablename) and attnum>0 and not attisdropped;
    execute format('revoke all (%s) on table public.%I from public, anon, authenticated',columns_list,t.tablename);
    execute format('drop policy if exists "backend service only" on public.%I',t.tablename);
    execute format('create policy "backend service only" on public.%I for all to service_role using(true) with check(true)',t.tablename);
    execute format('grant all on table public.%I to service_role',t.tablename);
  end loop;
end;
$grants$;

-- Preserve token-free invoker views while preventing reads of raw encrypted
-- credentials, even by an authenticated user inside the correct business.
revoke all on table public.email_accounts from public, anon, authenticated;
grant select(id,business_id,user_id,provider,email_address,last_sync_at,created_at) on public.email_accounts to authenticated;
revoke all on table public.calendar_connections from public, anon, authenticated;
grant select(id,business_id,user_id,provider,ical_url,sync_status,sync_error,last_synced_at,created_at) on public.calendar_connections to authenticated;
alter view public.email_accounts_status set(security_invoker=true);
alter view public.calendar_connections_status set(security_invoker=true);
revoke all on public.email_accounts_status,public.calendar_connections_status from public,anon;
grant select on public.email_accounts_status,public.calendar_connections_status to authenticated;
grant all on public.email_accounts,public.calendar_connections to service_role;

-- Consolidate legacy user policies and keep role/tenant changes behind
-- trusted signup/invitation and owner-only role RPC paths.
revoke all on public.users from public,anon,authenticated;
revoke update(id,business_id,email,role,created_at,name,phone,last_seen_at) on public.users from public,anon,authenticated;
grant select,delete on public.users to authenticated;
grant update(name,phone,last_seen_at) on public.users to authenticated;
drop policy if exists "Users can update own profile" on public.users;
drop policy if exists "Users can view own profile" on public.users;
drop policy if exists "self update" on public.users;
drop policy if exists "self update profile" on public.users;
drop policy if exists "same business select" on public.users;
drop policy if exists "owner remove staff" on public.users;
create policy "same business select" on public.users for select to authenticated
  using(id=(select auth.uid()) or business_id=(select public.current_business_id()));
create policy "self update profile" on public.users for update to authenticated
  using(id=(select auth.uid())) with check(id=(select auth.uid()));
create policy "owner remove staff" on public.users for delete to authenticated
  using(business_id=(select public.current_business_id()) and (select public.current_business_role())='owner' and id<>(select auth.uid()));

-- Public pages now use get_public_business(). Authenticated staff retain
-- access to their own complete business record through RLS.
drop policy if exists "public read" on public.businesses;
drop policy if exists "own business read" on public.businesses;
create policy "own business read" on public.businesses for select to authenticated
  using(id=(select public.current_business_id()));
revoke all on public.businesses from public,anon;
