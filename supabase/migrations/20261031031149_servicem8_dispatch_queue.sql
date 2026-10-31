begin;
alter table public.integration_tasks drop constraint if exists integration_tasks_kind_check;
alter table public.integration_tasks add constraint integration_tasks_kind_check
  check (kind in ('handoff','webhook','refresh_job','reminder','dispatch_seed'));
commit;
