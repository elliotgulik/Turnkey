-- Existing Wix/Meta connections are backend-only, including token hashes.
-- The original schema documented this but omitted enabling RLS/grant lockdown.
begin;
alter table public.lead_sources enable row level security;
revoke all on public.lead_sources from public, anon, authenticated;
grant all on public.lead_sources to service_role;
-- At most one connection per provider per business, enforced across races.
create unique index if not exists lead_sources_business_provider_unique
 on public.lead_sources(business_id,provider);
commit;
