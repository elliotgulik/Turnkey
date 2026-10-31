-- Enable low-latency refreshes for booking, dispatch and staff work pages.
-- Realtime still enforces each subscriber's authenticated RLS visibility.
do $$
declare
  v_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication is not present; skipping realtime table registration';
    return;
  end if;

  foreach v_table in array array[
    'calendar_events',
    'jobs',
    'job_work_logs',
    'equipment_usage',
    'equipment_assets',
    'equipment_service_events'
  ] loop
    if to_regclass(format('public.%I', v_table)) is not null
       and not exists (
         select 1 from pg_publication_tables
         where pubname = 'supabase_realtime'
           and schemaname = 'public'
           and tablename = v_table
       ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end
$$;
