-- TurnKey push notifications (OneSignal) — Phase 1/2.
-- Run this once in the Supabase SQL editor, after schema-notifications.sql
-- and schema-public-quote.sql. Safe to re-run: idempotent.

-- ===== notification_subscriptions: one row per device/browser a user has
-- enabled push on. A user can have several (phone + laptop), so this is its
-- own table, not a column on users — matches the existing
-- calendar_connections/email_accounts precedent (one row per external
-- connection, not a single column crammed onto users/businesses). =====
create table if not exists public.notification_subscriptions (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  onesignal_subscription_id text not null,
  device_type text, -- 'web' | 'ios' | 'android' — web push only in this phase, column kept for the native-app phase this is designed to lead into
  -- Disabling push updates this to false rather than deleting the row, so
  -- re-enabling on the same device doesn't lose its history and
  -- sendNotification() has one simple filter (enabled=true) rather than
  -- "row exists at all" as its enabled/disabled signal.
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (onesignal_subscription_id)
);
create index if not exists notification_subscriptions_business_idx on public.notification_subscriptions (business_id, user_id);

alter table public.notification_subscriptions enable row level security;
drop policy if exists "read own business" on public.notification_subscriptions;
create policy "read own business" on public.notification_subscriptions
  for select
  using (business_id = public.current_business_id());
-- A user manages only their OWN device subscriptions (not a teammate's) —
-- narrower than the usual "any owner/manager" write policy elsewhere,
-- since enabling/disabling push is inherently a per-device, per-person
-- action, not a business-wide setting like pricing or workflow config.
drop policy if exists "manage own subscription" on public.notification_subscriptions;
create policy "manage own subscription" on public.notification_subscriptions
  for all
  using (business_id = public.current_business_id() and user_id = auth.uid())
  with check (business_id = public.current_business_id() and user_id = auth.uid());

-- ===== notifications: in-app notification history (Phase 5's bell icon
-- reads from this table) — a log of every push actually sent, independent
-- of whether the recipient had push enabled/permitted at the time, so the
-- in-app centre still shows a full history even for a user who's never
-- turned push on. =====
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  user_id uuid references auth.users(id) on delete cascade, -- null = sent to the whole business (no single-user target resolved)
  type text not null,
  title text not null,
  message text not null,
  url text, -- where a click on this notification should open (see Phase 6)
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_business_idx on public.notifications (business_id, created_at desc);

alter table public.notifications enable row level security;
drop policy if exists "read own business" on public.notifications;
create policy "read own business" on public.notifications
  for select
  using (business_id = public.current_business_id());
-- Only the backend (service role, bypasses RLS) ever INSERTs a notification
-- — a client marking their own read/cleared state is the only client write.
drop policy if exists "update own business" on public.notifications;
create policy "update own business" on public.notifications
  for update
  using (business_id = public.current_business_id())
  with check (business_id = public.current_business_id());
drop policy if exists "delete own business" on public.notifications;
create policy "delete own business" on public.notifications
  for delete
  using (business_id = public.current_business_id());

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
END $$;

-- ===== quote_viewed: add the missing event key (notification_preferences'
-- existing check constraint — schema-notifications.sql — didn't have one),
-- and a once-only "has this quote been opened" marker on quotes itself so
-- the viewed push can only ever fire once per quote, not once per reload. =====
alter table public.notification_preferences drop constraint if exists notification_preferences_event_check;
alter table public.notification_preferences add constraint notification_preferences_event_check check (event in (
  'new_lead','quote_accepted','quote_viewed','job_booked','job_tomorrow','invoice_overdue','payment_received','review_requested'
));
alter table public.quotes add column if not exists viewed_at timestamptz;

-- ===== invoice_overdue push dedupe: mirrors lifecycle_email_log's existing
-- job_id+key uniqueness pattern (schema-calendar-and-checklists.sql) so the
-- daily automation sweep (run-due) never pushes the same overdue invoice
-- twice. Keyed on invoice id, not job id, since an invoice is what's overdue. =====
create table if not exists public.overdue_push_log (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  sent_at timestamptz not null default now(),
  unique (invoice_id)
);
