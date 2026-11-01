-- Additive internal quote-learning history. No existing jobs/quotes/rates are rewritten.
create table if not exists public.pricing_learning_settings (
  business_id text primary key references public.businesses(id) on delete cascade,
  enabled boolean not null default true,
  min_samples integer not null default 5 check (min_samples between 5 and 50),
  max_adjustment numeric not null default 0.25 check (max_adjustment between 0 and 0.35)
);
create table if not exists public.pricing_learning_observations (
  id uuid primary key default gen_random_uuid(),
  business_id text not null references public.businesses(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  quote_key text not null check (length(quote_key) between 1 and 128),
  line_key text not null check (length(line_key) between 1 and 128),
  svc text not null check (length(svc) between 1 and 40),
  unit text not null check (length(unit) between 1 and 20),
  quantity numeric not null check (quantity > 0 and quantity <= 10000000),
  baseline_price numeric not null check (baseline_price > 0 and baseline_price <= 10000000),
  chosen_price numeric not null check (chosen_price >= 0 and chosen_price <= 10000000),
  reason text not null check (reason in ('pricing_correction','difficult_access','extra_work','discount','measurement_correction','unexplained')),
  storeys integer not null default 1 check (storeys between 1 and 4),
  access text not null default 'standard' check (access in ('easy','standard','hard')),
  measured_quantity numeric,
  verified_quantity numeric,
  measurement_reason text,
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context)='object'),
  created_at timestamptz not null default now(),
  unique (business_id,quote_key,line_key),
  check ((measured_quantity is null and verified_quantity is null and measurement_reason is null)
    or (measured_quantity > 0 and measured_quantity <= 10000000
      and verified_quantity > 0 and verified_quantity <= 10000000
      and measured_quantity is not null and verified_quantity is not null and measurement_reason is not null
      and measurement_reason in ('verified_measurement','manual_measurement','site_measurement','measurement_correction'))),
  check (reason <> 'measurement_correction' or verified_quantity is not null)
);
create index if not exists pricing_learning_observations_business_job_idx
  on public.pricing_learning_observations (business_id,job_id);
alter table public.pricing_learning_settings enable row level security;
alter table public.pricing_learning_observations enable row level security;
-- Backend resolves membership and business before every read/write. Public quotes
-- and client Supabase sessions have no direct access to private pricing evidence.
revoke all on public.pricing_learning_settings,public.pricing_learning_observations from public,anon,authenticated;
grant select,insert,update,delete on public.pricing_learning_settings,public.pricing_learning_observations to service_role;
