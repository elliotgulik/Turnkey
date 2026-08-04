-- The Customer Profile's Activity tab (index.html, ACTIVITY_META) is meant
-- to be a unified timeline of everything that's happened with a customer,
-- but two of the most basic events were never being written to
-- activity_log at all: a lead arriving, and a photo being attached to a
-- job/quote/customer. Not a bug in the timeline's rendering — those two
-- event types simply never had a matching logActivity() call anywhere in
-- the app, so there was nothing to render. This adds the two missing
-- types to the check constraint; the matching frontend logActivity() call
-- sites are added in the same change.
--
-- Safe to re-run: idempotent (same drop/add-constraint pattern as
-- schema-public-quote.sql, which last touched this constraint).

alter table public.activity_log drop constraint if exists activity_log_type_check;
alter table public.activity_log add constraint activity_log_type_check check (type in (
  'note','lead_created','quote_sent','quote_viewed','quote_accepted','quote_declined','quote_updated','job_scheduled','job_completed',
  'invoice_sent','invoice_paid','follow_up_sent','email_sent','email_received','status_change','photo_added'
));
