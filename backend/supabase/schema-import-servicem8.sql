-- ServiceM8 importer: extends the generic import engine (schema-import-wizard.sql)
-- with the extra fields a ServiceM8 export carries that the generic importer
-- didn't need — billing/tax details on customers, and richer job/invoice
-- fields (category, work completed, payment method/date, due date, etc).
-- Run this AFTER schema-import-wizard.sql. Safe to re-run: idempotent.
--
-- Other sources (jobber/housecallpro/tradify/fergus/generic) are unaffected:
-- every new field read here is read with `row_data->>'x'`, which is simply
-- null for any source that doesn't send it.

alter table public.customers add column if not exists details jsonb;

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
  cust_details jsonb;
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

      -- Built separately (not inline in the insert) because a jsonb key whose
      -- *value* is JSON null (e.g. a present-but-empty `tags`) still reads as
      -- "not SQL null" via `->`, which would otherwise leave `details` as an
      -- empty `{}` instead of staying properly null when there's nothing to store.
      cust_details := jsonb_strip_nulls(jsonb_build_object(
        'billingAddress', nullif(trim(row_data->>'billing_address'),''),
        'paymentTerms', nullif(trim(row_data->>'payment_terms'),''),
        'taxRate', nullif(trim(row_data->>'tax_rate'),''),
        'tags', row_data->'tags'
      ));
      if cust_details = '{}'::jsonb then cust_details := null; end if;

      insert into public.customers (business_id,name,email,phone,address,suburb,notes,source,details)
      values (biz, trim(row_data->>'name'), nullif(trim(row_data->>'email'),''), nullif(trim(row_data->>'phone'),''),
              nullif(trim(row_data->>'address'),''), nullif(trim(row_data->>'suburb'),''),
              nullif(trim(row_data->>'notes'),''), coalesce(nullif(trim(row_data->>'source'),''), 'Imported — '||coalesce(p_source,'generic')),
              cust_details)
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
        jsonb_strip_nulls(jsonb_build_object(
          'services','[]'::jsonb,
          'total', coalesce((row_data->>'total')::numeric, 0),
          'importedFrom', coalesce(p_source,'generic'),
          'originalStatus', row_data->>'raw_status',
          'name', row_data->>'customer_name',
          'notes', row_data->>'notes',
          'address', row_data->>'address',
          'suburb', row_data->>'suburb',
          'category', row_data->>'category',
          'workCompleted', row_data->>'work_completed',
          'tags', row_data->'tags',
          'quoteDate', row_data->>'quote_date',
          'workOrderDate', row_data->>'work_order_date',
          'completionDate', row_data->>'completion_date',
          'poNumber', row_data->>'po_number',
          'invoiceNo', row_data->>'invoice_no',
          'paymentAmountRecorded', (row_data->>'payment_amount_recorded')::numeric,
          'paidAt', case when (row_data->>'payment_date') is not null
                         then ((row_data->>'payment_date')::date::timestamptz)
                         else null end
        ))
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

      insert into public.invoices (business_id,job_id,amount,paid,payment_status,payment_date,payment_method,due_date)
      values (
        biz, existing_id::text, coalesce((row_data->>'amount')::numeric,0), coalesce((row_data->>'paid')::boolean,false),
        nullif(trim(row_data->>'payment_status'),''),
        nullif(row_data->>'payment_date','')::date,
        nullif(trim(row_data->>'payment_method'),''),
        nullif(row_data->>'due_date','')::date
      )
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
