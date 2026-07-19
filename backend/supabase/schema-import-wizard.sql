-- TurnKey Import Wizard: transactional multi-entity CSV import engine.
-- Run this once in the Supabase SQL editor. Safe to re-run: idempotent.
-- Depends on public.current_business_id() / current_business_role() from
-- fix-rls-recursion.sql — run that first if you haven't already.
--
-- ARCHITECTURE: the wizard (CSV parsing, per-CRM column mapping, preview) is
-- entirely client-side JS. The only thing that touches the database is
-- run_import(), one security-definer RPC call that receives already-mapped,
-- normalized rows as jsonb and performs the entire multi-table write as a
-- single Postgres function call — which Postgres runs as one transaction by
-- default, so a systemic failure partway through rolls back everything
-- automatically. Individual bad rows are caught per-row (via a sub-transaction
-- savepoint) and reported in `errors` without aborting the rows around them —
-- "transactional" here means "never left in a half-written state by a crash",
-- not "one typo in row 400 discards the other 999 good rows".
--
-- This same function is the intended target for a future API-based importer:
-- anything that can produce the same {ref, ...fields} jsonb shape (whether
-- parsed from a CSV or pulled from a source CRM's API) can call run_import()
-- unchanged. The CSV-specific work (column mapping, file parsing) never
-- touches this file.

-- ===== import_batches: one row per import attempt, doubles as the import log =====
create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  source text not null,               -- 'servicem8'|'jobber'|'housecallpro'|'tradify'|'fergus'|'generic'
  status text not null default 'running', -- running|completed|failed|undone
  counts jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references auth.users(id)
);

-- ===== import_records: one row per entity created by an import — powers
-- duplicate detection (across batches) and undo (delete exactly these rows) =====
create table if not exists public.import_records (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.import_batches(id) on delete cascade,
  business_id text not null,
  entity_type text not null check (entity_type in ('customer','job','quote','invoice')),
  entity_id uuid not null,
  dedupe_key text,
  created_at timestamptz not null default now()
);
create index if not exists import_records_dedupe_idx on public.import_records (business_id, entity_type, dedupe_key);
create index if not exists import_records_batch_idx on public.import_records (batch_id);

alter table public.import_batches enable row level security;
alter table public.import_records enable row level security;

drop policy if exists "own business" on public.import_batches;
create policy "own business" on public.import_batches
  for select
  using (business_id = public.current_business_id());

drop policy if exists "own business" on public.import_records;
create policy "own business" on public.import_records
  for select
  using (business_id = public.current_business_id());
-- No insert/update/delete policies on either table for regular clients —
-- all writes happen exclusively inside run_import()/undo_import(), which run
-- as security definer and bypass RLS. This means an import can only ever be
-- created or undone through those two functions, never via a direct table
-- write from the browser, even by an owner.

-- ===== run_import: the transactional engine =====
-- p_customers/p_jobs/p_quotes/p_invoices are jsonb arrays of already-mapped
-- rows. Every row carries a `ref` (the CSV's own row identity, e.g. a
-- spreadsheet row number or source ID) used only to resolve relationships
-- within this same call (customer_ref on a job → the customer's `ref`) — it
-- is never trusted as a database id.
create or replace function public.run_import(
  p_source text,
  p_customers jsonb default '[]'::jsonb,
  p_jobs jsonb default '[]'::jsonb,
  p_quotes jsonb default '[]'::jsonb,
  p_invoices jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  biz text;
  role text;
  batch_id uuid;
  ref_customers jsonb := '{}'::jsonb;  -- ref -> customer uuid (text)
  ref_jobs jsonb := '{}'::jsonb;
  ref_quotes jsonb := '{}'::jsonb;
  row_data jsonb;
  new_id uuid;
  existing_id uuid;
  dkey text;
  cust_customer_ref text;
  cust_job_ref text;
  cust_quote_ref text;
  n_cust_in int := 0; n_cust_dup int := 0; n_cust_err int := 0;
  n_job_in int := 0;  n_job_dup int := 0;  n_job_err int := 0;
  n_quote_in int := 0; n_quote_dup int := 0; n_quote_err int := 0;
  n_inv_in int := 0;  n_inv_dup int := 0;  n_inv_err int := 0;
  errors jsonb := '[]'::jsonb;
  warnings jsonb := '[]'::jsonb;
begin
  biz := public.current_business_id();
  role := public.current_business_role();
  if biz is null then
    raise exception 'no business context for current user';
  end if;
  if role not in ('owner','manager') then
    raise exception 'only an owner or manager can run an import';
  end if;

  insert into public.import_batches (business_id, source, status, created_by)
  values (biz, coalesce(p_source,'generic'), 'running', auth.uid())
  returning id into batch_id;

  -- ===== customers =====
  for row_data in select * from jsonb_array_elements(coalesce(p_customers,'[]'::jsonb))
  loop
    begin
      if coalesce(trim(row_data->>'name'),'') = '' then
        n_cust_err := n_cust_err + 1;
        errors := errors || jsonb_build_object('entity','customer','ref',row_data->>'ref','message','Missing customer name — row skipped');
        continue;
      end if;

      dkey := lower(trim(row_data->>'name')) || '|' ||
              coalesce(regexp_replace(row_data->>'phone','\D','','g'),'') || '|' ||
              coalesce(lower(trim(row_data->>'email')),'');

      -- Duplicate check against EXISTING customers for this business (not just
      -- prior imports) — also catches customers already entered manually.
      select id into existing_id from public.customers
        where business_id = biz
          and lower(trim(name)) = lower(trim(row_data->>'name'))
          and (
            (nullif(trim(row_data->>'email'),'') is not null and lower(trim(email)) = lower(trim(row_data->>'email')))
            or (nullif(regexp_replace(coalesce(row_data->>'phone',''),'\D','','g'),'') is not null
                and regexp_replace(coalesce(phone,''),'\D','','g') = regexp_replace(row_data->>'phone','\D','','g'))
          )
        limit 1;

      if existing_id is not null then
        n_cust_dup := n_cust_dup + 1;
        if row_data->>'ref' is not null then
          ref_customers := ref_customers || jsonb_build_object(row_data->>'ref', existing_id::text);
        end if;
        ref_customers := ref_customers || jsonb_build_object('name:'||lower(trim(row_data->>'name')), existing_id::text);
        continue;
      end if;

      insert into public.customers (business_id,name,email,phone,address,suburb,notes,source)
      values (biz, trim(row_data->>'name'), nullif(trim(row_data->>'email'),''), nullif(trim(row_data->>'phone'),''),
              nullif(trim(row_data->>'address'),''), nullif(trim(row_data->>'suburb'),''),
              nullif(trim(row_data->>'notes'),''), coalesce(nullif(trim(row_data->>'source'),''), 'Imported — '||coalesce(p_source,'generic')))
      returning id into new_id;

      insert into public.import_records (batch_id,business_id,entity_type,entity_id,dedupe_key) values (batch_id,biz,'customer',new_id,dkey);
      if row_data->>'ref' is not null then
        ref_customers := ref_customers || jsonb_build_object(row_data->>'ref', new_id::text);
      end if;
      -- Also register by normalized name, so a jobs/quotes file that links to
      -- customers by name (very common when the source export has no shared
      -- ID column) resolves without the customer file needing an explicit ref.
      ref_customers := ref_customers || jsonb_build_object('name:'||lower(trim(row_data->>'name')), new_id::text);
      n_cust_in := n_cust_in + 1;
    exception when others then
      n_cust_err := n_cust_err + 1;
      errors := errors || jsonb_build_object('entity','customer','ref',row_data->>'ref','message',SQLERRM);
    end;
  end loop;

  -- ===== jobs (resolve customer_ref → real customer id) =====
  for row_data in select * from jsonb_array_elements(coalesce(p_jobs,'[]'::jsonb))
  loop
    begin
      cust_customer_ref := row_data->>'customer_ref';
      existing_id := nullif(ref_customers->>cust_customer_ref, '')::uuid;
      if existing_id is null and cust_customer_ref is not null then
        existing_id := nullif(ref_customers->>('name:'||lower(trim(cust_customer_ref))), '')::uuid;
      end if;
      if cust_customer_ref is not null and existing_id is null then
        n_job_err := n_job_err + 1;
        errors := errors || jsonb_build_object('entity','job','ref',row_data->>'ref','message','Could not resolve customer_ref "'||cust_customer_ref||'" — row skipped');
        continue;
      end if;

      dkey := coalesce(p_source,'generic')||':'||coalesce(row_data->>'ref','');
      if row_data->>'ref' is not null then
        select entity_id into new_id from public.import_records
          where business_id = biz and entity_type = 'job' and dedupe_key = dkey limit 1;
        if new_id is not null then
          n_job_dup := n_job_dup + 1;
          ref_jobs := ref_jobs || jsonb_build_object(row_data->>'ref', new_id::text);
          continue;
        end if;
      end if;

      insert into public.jobs (business_id,customer_id,status,scheduled_date,details)
      values (
        biz, existing_id, coalesce(nullif(trim(row_data->>'status'),''),'new'),
        nullif(row_data->>'scheduled_date','')::date,
        jsonb_build_object(
          'services','[]'::jsonb,
          'total', coalesce((row_data->>'total')::numeric, 0),
          'importedFrom', coalesce(p_source,'generic'),
          'originalStatus', row_data->>'raw_status',
          'name', row_data->>'customer_name',
          'notes', row_data->>'notes'
        )
      )
      returning id into new_id;

      insert into public.import_records (batch_id,business_id,entity_type,entity_id,dedupe_key) values (batch_id,biz,'job',new_id,dkey);
      if row_data->>'ref' is not null then
        ref_jobs := ref_jobs || jsonb_build_object(row_data->>'ref', new_id::text);
      end if;
      n_job_in := n_job_in + 1;
    exception when others then
      n_job_err := n_job_err + 1;
      errors := errors || jsonb_build_object('entity','job','ref',row_data->>'ref','message',SQLERRM);
    end;
  end loop;

  -- ===== quotes (resolve customer_ref) =====
  for row_data in select * from jsonb_array_elements(coalesce(p_quotes,'[]'::jsonb))
  loop
    begin
      cust_customer_ref := row_data->>'customer_ref';
      existing_id := nullif(ref_customers->>cust_customer_ref, '')::uuid;
      if existing_id is null and cust_customer_ref is not null then
        existing_id := nullif(ref_customers->>('name:'||lower(trim(cust_customer_ref))), '')::uuid;
      end if;
      if cust_customer_ref is not null and existing_id is null then
        n_quote_err := n_quote_err + 1;
        errors := errors || jsonb_build_object('entity','quote','ref',row_data->>'ref','message','Could not resolve customer_ref "'||cust_customer_ref||'" — row skipped');
        continue;
      end if;

      dkey := coalesce(p_source,'generic')||':'||coalesce(row_data->>'ref','');
      if row_data->>'ref' is not null then
        select entity_id into new_id from public.import_records
          where business_id = biz and entity_type = 'quote' and dedupe_key = dkey limit 1;
        if new_id is not null then
          n_quote_dup := n_quote_dup + 1;
          ref_quotes := ref_quotes || jsonb_build_object(row_data->>'ref', new_id::text);
          continue;
        end if;
      end if;

      insert into public.quotes (business_id,lead_id,amount,status)
      values (biz, existing_id::text, coalesce((row_data->>'amount')::numeric,0), coalesce(nullif(trim(row_data->>'status'),''),'sent'))
      returning id into new_id;

      insert into public.import_records (batch_id,business_id,entity_type,entity_id,dedupe_key) values (batch_id,biz,'quote',new_id,dkey);
      if row_data->>'ref' is not null then
        ref_quotes := ref_quotes || jsonb_build_object(row_data->>'ref', new_id::text);
      end if;
      -- Link the quote back onto its job when both were provided in the same import.
      cust_job_ref := row_data->>'job_ref';
      if cust_job_ref is not null and ref_jobs->>cust_job_ref is not null then
        update public.jobs set quote_id = new_id::text where id = (ref_jobs->>cust_job_ref)::uuid and business_id = biz;
      end if;
      n_quote_in := n_quote_in + 1;
    exception when others then
      n_quote_err := n_quote_err + 1;
      errors := errors || jsonb_build_object('entity','quote','ref',row_data->>'ref','message',SQLERRM);
    end;
  end loop;

  -- ===== invoices (resolve job_ref) =====
  for row_data in select * from jsonb_array_elements(coalesce(p_invoices,'[]'::jsonb))
  loop
    begin
      cust_job_ref := row_data->>'job_ref';
      existing_id := nullif(ref_jobs->>cust_job_ref, '')::uuid;
      if cust_job_ref is not null and existing_id is null then
        n_inv_err := n_inv_err + 1;
        errors := errors || jsonb_build_object('entity','invoice','ref',row_data->>'ref','message','Could not resolve job_ref "'||cust_job_ref||'" — row skipped');
        continue;
      end if;

      dkey := coalesce(p_source,'generic')||':'||coalesce(row_data->>'ref','');
      if row_data->>'ref' is not null then
        perform 1 from public.import_records
          where business_id = biz and entity_type = 'invoice' and dedupe_key = dkey limit 1;
        if found then
          n_inv_dup := n_inv_dup + 1;
          continue;
        end if;
      end if;

      insert into public.invoices (business_id,job_id,amount,paid)
      values (biz, existing_id::text, coalesce((row_data->>'amount')::numeric,0), coalesce((row_data->>'paid')::boolean,false))
      returning id into new_id;

      insert into public.import_records (batch_id,business_id,entity_type,entity_id,dedupe_key) values (batch_id,biz,'invoice',new_id,dkey);
      n_inv_in := n_inv_in + 1;
    exception when others then
      n_inv_err := n_inv_err + 1;
      errors := errors || jsonb_build_object('entity','invoice','ref',row_data->>'ref','message',SQLERRM);
    end;
  end loop;

  if jsonb_array_length(errors) > 0 then
    warnings := warnings || jsonb_build_object('message', jsonb_array_length(errors)||' row(s) could not be imported — see the error report.');
  end if;

  update public.import_batches set
    status = 'completed',
    counts = jsonb_build_object(
      'customers', jsonb_build_object('inserted',n_cust_in,'duplicates',n_cust_dup,'errors',n_cust_err),
      'jobs',      jsonb_build_object('inserted',n_job_in,'duplicates',n_job_dup,'errors',n_job_err),
      'quotes',    jsonb_build_object('inserted',n_quote_in,'duplicates',n_quote_dup,'errors',n_quote_err),
      'invoices',  jsonb_build_object('inserted',n_inv_in,'duplicates',n_inv_dup,'errors',n_inv_err)
    ),
    errors = errors,
    warnings = warnings
  where id = batch_id;

  return jsonb_build_object(
    'batch_id', batch_id,
    'status', 'completed',
    'counts', jsonb_build_object(
      'customers', jsonb_build_object('inserted',n_cust_in,'duplicates',n_cust_dup,'errors',n_cust_err),
      'jobs',      jsonb_build_object('inserted',n_job_in,'duplicates',n_job_dup,'errors',n_job_err),
      'quotes',    jsonb_build_object('inserted',n_quote_in,'duplicates',n_quote_dup,'errors',n_quote_err),
      'invoices',  jsonb_build_object('inserted',n_inv_in,'duplicates',n_inv_dup,'errors',n_inv_err)
    ),
    'errors', errors,
    'warnings', warnings
  );
end;
$$;

revoke all on function public.run_import(text,jsonb,jsonb,jsonb,jsonb) from public;
grant execute on function public.run_import(text,jsonb,jsonb,jsonb,jsonb) to authenticated;

-- ===== undo_import: hard-delete exactly the rows a batch created, in FK-safe order =====
create or replace function public.undo_import(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  biz text;
  role text;
  batch_biz text;
  batch_status text;
  n_deleted int := 0;
  rec record;
begin
  biz := public.current_business_id();
  role := public.current_business_role();
  if role not in ('owner','manager') then
    raise exception 'only an owner or manager can undo an import';
  end if;

  select business_id, status into batch_biz, batch_status from public.import_batches where id = p_batch_id;
  if batch_biz is null then
    raise exception 'import batch not found';
  end if;
  if batch_biz <> biz then
    raise exception 'import batch does not belong to your business';
  end if;
  if batch_status = 'undone' then
    raise exception 'this import was already undone';
  end if;

  -- Delete in dependency order: invoices, quotes, jobs, customers.
  for rec in select entity_id from public.import_records where batch_id = p_batch_id and entity_type = 'invoice' loop
    delete from public.invoices where id = rec.entity_id and business_id = biz;
    n_deleted := n_deleted + 1;
  end loop;
  for rec in select entity_id from public.import_records where batch_id = p_batch_id and entity_type = 'quote' loop
    delete from public.quotes where id = rec.entity_id and business_id = biz;
    n_deleted := n_deleted + 1;
  end loop;
  for rec in select entity_id from public.import_records where batch_id = p_batch_id and entity_type = 'job' loop
    delete from public.jobs where id = rec.entity_id and business_id = biz;
    n_deleted := n_deleted + 1;
  end loop;
  for rec in select entity_id from public.import_records where batch_id = p_batch_id and entity_type = 'customer' loop
    delete from public.customers where id = rec.entity_id and business_id = biz;
    n_deleted := n_deleted + 1;
  end loop;

  update public.import_batches set status = 'undone', undone_at = now(), undone_by = auth.uid() where id = p_batch_id;

  return jsonb_build_object('batch_id', p_batch_id, 'status', 'undone', 'rows_deleted', n_deleted);
end;
$$;

revoke all on function public.undo_import(uuid) from public;
grant execute on function public.undo_import(uuid) to authenticated;
