begin;
create or replace function public.guard_customer_identity()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if nullif(btrim(new.name),'') is null then
    raise exception 'Customer name is missing. Reload the customer before saving.' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_customer_identity() from public,anon,authenticated;
drop trigger if exists guard_customer_identity on public.customers;
create trigger guard_customer_identity before insert or update on public.customers
for each row execute function public.guard_customer_identity();
create or replace function public.guard_job_intake_answers()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if new.customer_id is distinct from old.customer_id and new.customer_id is not null
     and exists(select 1 from public.customers c where c.id=new.customer_id and c.business_id=new.business_id and nullif(btrim(c.name),'') is null) then
    raise exception 'Cannot replace the job customer with an incomplete profile. Reload before saving.' using errcode='23514';
  end if;
  if jsonb_typeof(old.details->'formAnswers')='array' and jsonb_array_length(old.details->'formAnswers')>0
     and (not coalesce(new.details,'{}'::jsonb) ? 'formAnswers' or new.details->'formAnswers' in ('null'::jsonb,'[]'::jsonb)) then
    new.details:=coalesce(new.details,'{}'::jsonb)||jsonb_build_object('formAnswers',old.details->'formAnswers');
  end if;
  if jsonb_typeof(old.details->'formAnswers')='array' and jsonb_array_length(old.details->'formAnswers')>0
     and jsonb_typeof(old.details->'requestedServices')='array' and jsonb_array_length(old.details->'requestedServices')>0
     and (not coalesce(new.details,'{}'::jsonb) ? 'requestedServices' or new.details->'requestedServices' in ('null'::jsonb,'[]'::jsonb)) then
    new.details:=coalesce(new.details,'{}'::jsonb)||jsonb_build_object('requestedServices',old.details->'requestedServices');
  end if;
  return new;
end;
$$;
revoke all on function public.guard_job_intake_answers() from public,anon,authenticated;
drop trigger if exists aab_guard_job_intake_answers on public.jobs;
create trigger aab_guard_job_intake_answers before update on public.jobs
for each row execute function public.guard_job_intake_answers();
commit;
