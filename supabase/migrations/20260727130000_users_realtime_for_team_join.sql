-- Adds public.users to the supabase_realtime publication so index.html's
-- existing realtime channel (subscribeRealtime(), already listening for
-- activity_log INSERTs to catch a customer's live quote response) can ALSO
-- hear about a new row appearing in users the moment an invite gets
-- accepted or a new business owner signs up — powering the
-- team_member_joined push notification.
--
-- Deliberately NOT done by adding an HTTP call inside handle_new_user()
-- (the signup trigger) — that trigger runs on every single signup for
-- every business on this platform, is security-definer, and a network call
-- failing/timing out inside it risks blocking signup entirely, which is far
-- too large a blast radius for a "notify the owner" convenience feature.
-- Realtime is the safe path: it observes the row handle_new_user() already
-- writes, without the trigger itself needing to know or care that a push
-- notification exists.
--
-- Realtime still goes through this table's own RLS ("same business select"
-- from schema-team.sql / current_business_id()-based from
-- fix-rls-recursion.sql), so a subscribed session only ever receives INSERT
-- events for users in its own business — same boundary as every other
-- realtime subscription already in this app. Checked via
-- pg_publication_tables rather than a bare ALTER PUBLICATION ADD TABLE,
-- which errors (not idempotent) if this has already run once — same
-- pattern already used for activity_log/notifications.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'users'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
  END IF;
END $$;
