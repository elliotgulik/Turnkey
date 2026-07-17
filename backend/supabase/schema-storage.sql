-- TurnKey Storage: attachments table + storage.objects RLS.
-- Run this once in the Supabase SQL editor. Safe to re-run: idempotent.
-- The 'turnkey-uploads' bucket itself was created via the Storage API (private,
-- 10MB limit, image/pdf mime types only) — nothing to do for that here.

-- ===== attachments: one row per uploaded file, linked to a customer and/or job =====
create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  customer_id uuid references public.customers(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete cascade,
  kind text not null check (kind in ('customer_photo','job_photo','quote_attachment')),
  path text not null,
  filename text,
  created_at timestamptz not null default now()
);

alter table public.attachments enable row level security;

drop policy if exists "own business" on public.attachments;
create policy "own business" on public.attachments
  for all
  using (business_id = (select business_id from public.users where id = auth.uid()))
  with check (business_id = (select business_id from public.users where id = auth.uid()));

-- ===== storage.objects: objects are stored under `{business_id}/...` —
-- the same "own business" scoping as every table, applied to the storage layer. =====
drop policy if exists "own business select" on storage.objects;
create policy "own business select" on storage.objects
  for select
  using (
    bucket_id = 'turnkey-uploads'
    and (storage.foldername(name))[1] = (select business_id from public.users where id = auth.uid())
  );

drop policy if exists "own business insert" on storage.objects;
create policy "own business insert" on storage.objects
  for insert
  with check (
    bucket_id = 'turnkey-uploads'
    and (storage.foldername(name))[1] = (select business_id from public.users where id = auth.uid())
  );

drop policy if exists "own business update" on storage.objects;
create policy "own business update" on storage.objects
  for update
  using (
    bucket_id = 'turnkey-uploads'
    and (storage.foldername(name))[1] = (select business_id from public.users where id = auth.uid())
  );

drop policy if exists "own business delete" on storage.objects;
create policy "own business delete" on storage.objects
  for delete
  using (
    bucket_id = 'turnkey-uploads'
    and (storage.foldername(name))[1] = (select business_id from public.users where id = auth.uid())
  );
