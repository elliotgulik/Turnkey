begin;
-- Backend-only configuration and durable outbox. No historic lead backfill.
create table if not exists public.lead_welcome_settings (
 business_id text primary key references public.businesses(id) on delete cascade,
 settings jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now()
);
create table if not exists public.lead_welcome_messages (
 id uuid primary key default gen_random_uuid(),
 business_id text not null references public.businesses(id) on delete cascade,
 lead_id uuid not null unique references public.leads(id) on delete cascade,
 channel text not null check(channel in ('sms','email')),
 settings jsonb not null,
 status text not null default 'queued' check(status in ('queued','sending','accepted','skipped','failed','unknown')),
 created_at timestamptz not null default now(),
 claimed_at timestamptz, sent_at timestamptz,
 provider_id text, error_summary text
);
create index if not exists lead_welcome_pending_idx on public.lead_welcome_messages(created_at) where status='queued';
create index if not exists lead_welcome_business_idx on public.lead_welcome_messages(business_id,created_at desc);
create table if not exists public.lead_welcome_suppressions (
 business_id text not null references public.businesses(id) on delete cascade,
 channel text not null check(channel in ('sms','email')),
 recipient text not null,
 created_at timestamptz not null default now(),
 primary key(business_id,channel,recipient)
);
alter table public.lead_welcome_settings enable row level security;
alter table public.lead_welcome_messages enable row level security;
alter table public.lead_welcome_suppressions enable row level security;
revoke all on public.lead_welcome_settings,public.lead_welcome_messages,public.lead_welcome_suppressions from public,anon,authenticated;
grant all on public.lead_welcome_settings,public.lead_welcome_messages,public.lead_welcome_suppressions to service_role;

-- Lead intake already requires the service role. INVOKER intentionally keeps
-- an untrusted insert from acquiring privileged configuration access.
create or replace function public.queue_lead_welcome() returns trigger
language plpgsql security invoker set search_path='' as $$
declare cfg jsonb;
begin
 select settings into cfg from public.lead_welcome_settings where business_id=new.business_id;
 if cfg->>'enabled'='true' and coalesce(new.payload->>'historicalImport','false')<>'true'
   and cfg->'sources' ? (case lower(coalesce(new.source,new.payload->>'source','manual')) when 'turnkey quote widget' then 'booking' else lower(coalesce(new.source,new.payload->>'source','manual')) end)
 then
   insert into public.lead_welcome_messages(business_id,lead_id,channel,settings)
   values(new.business_id,new.id,cfg->>'channel',cfg) on conflict(lead_id) do nothing;
 end if;
 return new;
end $$;
revoke all on function public.queue_lead_welcome() from public,anon,authenticated;
grant execute on function public.queue_lead_welcome() to service_role;
drop trigger if exists queue_lead_welcome on public.leads;
create trigger queue_lead_welcome after insert on public.leads for each row execute function public.queue_lead_welcome();

create or replace function public.claim_lead_welcomes() returns setof public.lead_welcome_messages
language sql security invoker set search_path='' as $$
 update public.lead_welcome_messages set status='sending',claimed_at=now()
 where id in (select id from public.lead_welcome_messages where status='queued'
 order by created_at limit 10 for update skip locked)
 returning *;
$$;
revoke all on function public.claim_lead_welcomes() from public,anon,authenticated;
grant execute on function public.claim_lead_welcomes() to service_role;

commit;
