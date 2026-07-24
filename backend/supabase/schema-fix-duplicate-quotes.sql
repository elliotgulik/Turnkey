-- Fixes the data left behind by a real bug in index.html's loadFromSupabase():
-- jobs.quote_id was written correctly on every save, but never read back
-- into the in-memory record on load. The next time an already-quoted job's
-- quote was saved in a NEW session (i.e. after any page reload/re-login),
-- the app had no idea a quote already existed for that job, so it inserted
-- a brand new row into `quotes` instead of updating the existing one — once
-- per job, per session, forever. A job quoted and revisited across many
-- sessions over weeks ends up with many rows in `quotes` all sharing the
-- same `lead_id`, which is exactly what the Customer Profile's "Quotes"
-- count/list surfaces — hence a customer with one real quote showing 144.
--
-- The code fix (loadFromSupabase now restores quoteId:j.quote_id) stops any
-- NEW duplicates. This file only cleans up rows that already exist.
--
-- ===== STEP 1 — run this first. Read-only, safe, shows you the scope. =====
select
  q.business_id,
  q.lead_id,
  c.name as customer_name,
  count(*) as quote_rows,
  count(*) filter (where exists (
    select 1 from public.jobs j where j.quote_id = q.id::text
  )) as rows_still_referenced_by_a_job
from public.quotes q
-- quotes.lead_id is text (not uuid) — same text/uuid split as jobs.quote_id
-- and invoices.job_id found in schema-scheduling.sql. Cast the uuid side to
-- match rather than casting lead_id to uuid, which would error on any row
-- whose lead_id isn't a well-formed uuid string.
left join public.customers c on c.id::text = q.lead_id
group by q.business_id, q.lead_id, c.name
having count(*) > 1
order by count(*) desc;

-- Read the output before doing anything else. "quote_rows" is how many
-- rows exist for that customer; "rows_still_referenced_by_a_job" is how
-- many of those are actually the current quote for some job (should almost
-- always be 1, occasionally more if the customer genuinely has several
-- separate jobs each with their own quote). Every row NOT in that
-- referenced set is orphaned — created by the bug, pointed at by nothing.

-- ===== STEP 2 — the actual cleanup. Deletes only orphaned rows: a quote
-- whose id is not the current quote_id of any job for that same business.
-- A legitimate quote for a real job is never touched, because jobs.quote_id
-- still points at it. Run STEP 1 again afterward — every group should now
-- show quote_rows = rows_still_referenced_by_a_job (i.e. no more duplicates). =====
delete from public.quotes q
where not exists (
  select 1 from public.jobs j
  where j.quote_id = q.id::text
    and j.business_id = q.business_id
);
