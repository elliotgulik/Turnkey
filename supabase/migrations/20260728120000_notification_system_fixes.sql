-- Fixes two real bugs found during a full notification-pipeline audit, plus
-- adds the one new event (job_started) and column (notifications.data) the
-- audit's requirements called for. Safe to re-run: idempotent.
--
-- ===== Bug 1 (the big one): notification_preferences.event's check
-- constraint only ever allowed 8 event keys —
--   'new_lead','quote_accepted','quote_viewed','job_booked','job_tomorrow',
--   'invoice_overdue','payment_received','review_requested'
-- — but index.html's Settings → Notifications screen (NOTIFICATION_EVENTS)
-- has always shown 16 toggles. saveNotificationPrefs() unconditionally
-- upserts a row for EVERY event on every save, so every save has been
-- silently failing the DB check constraint for the other 8 event types
-- (quote_sent, quote_declined, customer_question, job_rescheduled,
-- job_cancelled, job_today, invoice_created, customer_approved_work) — the
-- error was only ever console.error'd, never surfaced to the user, so a
-- business trying to turn push off for e.g. "Job cancelled" has had that
-- toggle silently do nothing, forever. Expanded to the full real list.
--
-- ===== Bug 2: this migration itself is the actual root cause of "push
-- notifications are not delivered on mobile" for anyone reading this file's
-- comment — see the accompanying report. It is NOT something a database
-- migration can fix: backend/src/services/notifications.js's isConfigured()
-- requires BOTH process.env.ONESIGNAL_APP_ID and process.env.ONESIGNAL_API_KEY
-- to be set on the BACKEND (Render/wherever backend/ is deployed — separate
-- from Netlify's TURNKEY_ONESIGNAL_APP_ID, which only reaches the frontend's
-- config.js). Neither was present in backend/.env. Every push send has been
-- taking the isConfigured()===false branch, which still writes the in-app
-- notification row (so the bell icon has always worked) but never actually
-- calls OneSignal's API. See the accompanying report for exactly what to set
-- and where.
--
-- ===== job_started: new event — notifies the business (owner/managers) the
-- moment a technician taps "Start job" (index.html's startJob()), previously
-- silent. Real-time field-operations visibility, matching the existing
-- quote_accepted/payment_received "notify owner" pattern.
--
-- ===== notifications.data: a generic jsonb payload column (the audit's
-- requested notifications-table shape included one) for future notification-
-- centre actions that need more structured context than a bare url — e.g. a
-- {jobId, customerId} pair a click handler can use instead of re-parsing the url.

alter table public.notification_preferences drop constraint if exists notification_preferences_event_check;
alter table public.notification_preferences add constraint notification_preferences_event_check check (event in (
  'new_lead','quote_sent','quote_viewed','quote_accepted','quote_declined','customer_question',
  'job_booked','job_rescheduled','job_cancelled','job_tomorrow','job_today','job_started',
  'invoice_created','invoice_overdue','payment_received','customer_approved_work','review_requested'
));

alter table public.notifications add column if not exists data jsonb;
