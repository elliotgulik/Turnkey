-- Backend-only progress, not another leads pipeline. Existing leads uniqueness
-- protects concurrent webhook, manual and automatic deliveries.
create table if not exists public.meta_lead_sync (
 source_id uuid primary key references public.lead_sources(id) on delete cascade,
 business_id text not null,
 page_id text not null,
 connection_updated_at timestamptz not null,
 cursor text,
 cycle_started_at timestamptz,
 last_success_at timestamptz,
 last_checked_at timestamptz,
 next_run_at timestamptz not null default now(),
 last_error text,
 imported_count bigint not null default 0,
 lease_until timestamptz,
 lease_token uuid
);
alter table public.meta_lead_sync enable row level security;
revoke all on public.meta_lead_sync from public,anon,authenticated;
grant all on public.meta_lead_sync to service_role;

create or replace function public.claim_meta_lead_sync(p_source_id uuid,p_lease_token uuid)
returns setof public.meta_lead_sync
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 insert into public.meta_lead_sync(source_id,business_id,page_id,connection_updated_at)
 select id,business_id,external_id,updated_at from public.lead_sources
 where id=p_source_id and provider='meta'
 on conflict(source_id) do nothing;
 return query update public.meta_lead_sync s set
  cursor=case when s.connection_updated_at<>c.updated_at then null else s.cursor end,
  cycle_started_at=case when s.connection_updated_at<>c.updated_at then now() else coalesce(s.cycle_started_at,now()) end,
  page_id=c.external_id,business_id=c.business_id,connection_updated_at=c.updated_at,
  lease_until=now()+interval '3 minutes',lease_token=p_lease_token
 from public.lead_sources c where s.source_id=p_source_id and c.id=s.source_id and c.provider='meta'
 and (s.next_run_at<=now() or s.connection_updated_at<>c.updated_at)
 and (s.lease_until is null or s.lease_until<now())
 returning s.*;
end $$;
revoke all on function public.claim_meta_lead_sync(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_meta_lead_sync(uuid,uuid) to service_role;
-- The existing turnkey-servicem8-background-wakeup cron also keeps this
-- worker alive on Render; no new external scheduler or credential is needed.
