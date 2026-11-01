-- Prepared only; main will create/apply the tracked migration.
-- The existing aaa_guard_servicem8_operational_state trigger already calls
-- this function. Pricing authority is independent of operational stage.
begin;
create or replace function public.guard_servicem8_operational_state()
returns trigger language plpgsql security invoker set search_path=public as $$
declare k text;
begin
  if current_user in ('authenticated','anon') then
    new.details:=coalesce(new.details,'{}'::jsonb)-'serviceM8Pricing';
    if old.details ? 'serviceM8Pricing' then
      new.details:=new.details||jsonb_build_object('serviceM8Pricing',old.details->'serviceM8Pricing');
    end if;
    if coalesce(old.details->>'serviceM8Status','') in ('Work Order','Completed','Cancelled','Canceled','Unsuccessful') then
      new.status:=old.status;
      new.scheduled_date:=old.scheduled_date;
      foreach k in array array['serviceM8Status','serviceM8Booking','serviceM8Cancelled','serviceM8SyncedAt'] loop
        new.details:=new.details-k;
        if old.details ? k then new.details:=new.details||jsonb_build_object(k,old.details->k); end if;
      end loop;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_servicem8_operational_state() from public,anon,authenticated;
commit;
