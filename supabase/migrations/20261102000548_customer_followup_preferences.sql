alter table public.customers add column if not exists followups_disabled boolean not null default false;
comment on column public.customers.followups_disabled is 'Customer opt-out from sales follow-up queues and internal follow-up reminders; transactional/manual messages are separate.';
