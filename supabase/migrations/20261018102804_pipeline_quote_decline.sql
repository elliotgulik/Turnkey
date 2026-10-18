-- Customer declines are durable pipeline events, even while the CRM is closed.
-- Keep previously accepted/operational work and other tenants untouched.
create schema if not exists turnkey_private;
create or replace function turnkey_private.pipeline_quote_declined()
returns trigger language plpgsql security definer set search_path=pg_catalog,public
as $$
declare at_ms bigint := floor(extract(epoch from clock_timestamp())*1000);
begin
  if new.status='declined' and old.status is distinct from new.status then
    update public.jobs set status='cancelled',details=coalesce(details,'{}'::jsonb)||
      jsonb_build_object('lostAt',at_ms,'lostReason','Customer declined quote',
        'salesHistory',coalesce(details->'salesHistory','[]'::jsonb)||
          jsonb_build_array(jsonb_build_object('at',at_ms,'to','lost','label','Cancelled','automatic',true)))
    where quote_id=new.id::text and business_id=new.business_id
      and status not in ('won','scheduled','completed','paid','cancelled');
  end if;
  return new;
end;
$$;
revoke all on function turnkey_private.pipeline_quote_declined() from public,anon,authenticated;
grant execute on function turnkey_private.pipeline_quote_declined() to service_role;
drop trigger if exists turnkey_pipeline_quote_declined on public.quotes;
create trigger turnkey_pipeline_quote_declined after update of status on public.quotes
for each row execute function turnkey_private.pipeline_quote_declined();
