-- Offline-generated additive migration. Reporting tokens never share Meta Page webhook storage.
begin;
create table public.marketing_ad_connections (
 business_id text primary key, account_id text not null check(account_id ~ '^[0-9]{1,30}$'),
 account_name text not null, currency text not null check(currency ~ '^[A-Z]{3}$'), timezone text not null,
 token_enc text, generation uuid not null default gen_random_uuid(), revision bigint not null default 0,
 last_sync_at timestamptz, last_import_at timestamptz
);
create table public.marketing_daily_snapshots (
 id uuid primary key default gen_random_uuid(), business_id text not null references public.marketing_ad_connections(business_id),
 account_id text not null, level text not null check(level in ('campaign','adset','ad')), date date not null,
 rows jsonb not null check(jsonb_typeof(rows)='array'), source text not null check(source in ('meta','csv')),
 updated_at timestamptz not null default now(), unique(business_id,account_id,level,date)
);
create index marketing_snapshots_report on public.marketing_daily_snapshots(business_id,account_id,level,date);
create table public.marketing_attribution_links (
 id uuid primary key default gen_random_uuid(), business_id text not null references public.marketing_ad_connections(business_id),
 account_id text not null, job_id uuid not null references public.jobs(id) on delete cascade,
 ad_id text not null check(ad_id ~ '^[0-9]{1,30}$'), evidence text not null check(length(evidence) between 10 and 1000),
 reviewed_by uuid not null, reviewed_at timestamptz not null default now(), unique(business_id,account_id,job_id)
);
create index marketing_attribution_business on public.marketing_attribution_links(business_id,account_id);
-- No client-facing policies. Backend service role checks authenticated membership and role on EVERY route.
alter table public.marketing_ad_connections enable row level security;
alter table public.marketing_daily_snapshots enable row level security;
alter table public.marketing_attribution_links enable row level security;
revoke all on public.marketing_ad_connections,public.marketing_daily_snapshots,public.marketing_attribution_links from public,anon,authenticated;
grant all on public.marketing_ad_connections,public.marketing_daily_snapshots,public.marketing_attribution_links to service_role;

create function public.marketing_publish(p_business text,p_generation uuid,p_revision bigint,p_since date,p_until date,p_levels text[],p_rows jsonb,p_source text)
returns void language plpgsql security invoker set search_path = '' as $$
declare c public.marketing_ad_connections;
begin
 if p_since is null or p_until is null or p_until<p_since or p_until-p_since>365 or
    p_source is null or p_source not in ('meta','csv') or p_levels is null or cardinality(p_levels)=0 or
    not p_levels <@ array['campaign','adset','ad']::text[] or array_position(p_levels,null) is not null or
    p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>10000 then
   raise exception 'Invalid reporting batch';
 end if;
 -- Serialize publishers across backend processes and reject an outdated fetch/connection.
 select * into c from public.marketing_ad_connections where business_id=p_business for update;
 if not found or c.generation is distinct from p_generation or c.revision is distinct from p_revision then
   raise exception 'Reporting connection or revision changed; retry';
 end if;
 if exists(select 1 from jsonb_array_elements(p_rows) r where
   r->>'account_id' is distinct from c.account_id or r->>'currency' is distinct from c.currency or
   r->>'timezone' is distinct from c.timezone or not coalesce((r->>'level')=any(p_levels),false) or
   r->>'date' is null or (r->>'date')::date not between p_since and p_until) then
   raise exception 'Batch scope mismatch';
 end if;
 if exists(select 1 from jsonb_array_elements(p_rows) r group by r->>'date',r->>'level',r->>'campaign_id',r->>'adset_id',r->>'ad_id' having count(*)>1) then
   raise exception 'Duplicate reporting rows';
 end if;
 -- A complete day has a snapshot even when the provider returned no delivery rows.
 -- Replacing the whole daily array removes disappeared/revised entities atomically.
 insert into public.marketing_daily_snapshots(business_id,account_id,level,date,rows,source,updated_at)
 select p_business,c.account_id,l,d::date,
   coalesce((select jsonb_agg(r order by r->>'campaign_id',r->>'adset_id',r->>'ad_id')
     from jsonb_array_elements(p_rows) r where r->>'date'=to_char(d,'YYYY-MM-DD') and r->>'level'=l),'[]'::jsonb),p_source,now()
 from generate_series(p_since::timestamp,p_until::timestamp,interval '1 day') d
 cross join (select distinct unnest(p_levels) as l) selected
 on conflict(business_id,account_id,level,date) do update set rows=excluded.rows,source=excluded.source,updated_at=excluded.updated_at;
 update public.marketing_ad_connections set revision=revision+1,
  last_sync_at=case when p_source='meta' then now() else last_sync_at end,
  last_import_at=case when p_source='csv' then now() else last_import_at end where business_id=p_business;
end $$;
revoke all on function public.marketing_publish(text,uuid,bigint,date,date,text[],jsonb,text) from public,anon,authenticated;
grant execute on function public.marketing_publish(text,uuid,bigint,date,date,text[],jsonb,text) to service_role;
commit;
