-- Customer-facing quote approval: the single biggest missing piece of the
-- Lead -> Quote -> Customer Approval -> Schedule workflow. Today "accept" is
-- a business-side-only button (markWon() in index.html) — there is no way
-- for a customer to actually view or approve their own quote online. This
-- adds that, using the same security-definer-RPC boundary pattern already
-- established for run_import()/undo_import() rather than opening the base
-- tables to anonymous reads.
-- Run this after schema-app.sql, schema-business-profile.sql and
-- schema-customer-hub.sql. Safe to re-run: idempotent.

-- ===== quotes.public_token: unguessable id for sharing one quote via a link.
-- default gen_random_uuid() is evaluated per-row, so every existing quote
-- gets its own real token retroactively the moment this column is added —
-- nothing needs a backfill pass. =====
alter table public.quotes add column if not exists public_token uuid not null default gen_random_uuid();
create unique index if not exists quotes_public_token_idx on public.quotes (public_token);

-- ===== activity_log: add the two event types this flow needs. The customer
-- approving/declining online is meaningfully different from the business
-- marking it won by hand — the Customer Profile timeline should say so. =====
alter table public.activity_log drop constraint if exists activity_log_type_check;
alter table public.activity_log add constraint activity_log_type_check check (type in (
  'note','quote_sent','quote_viewed','quote_accepted','quote_declined','quote_updated','job_scheduled','job_completed',
  'invoice_sent','invoice_paid','follow_up_sent','email_sent','email_received','status_change'
));

-- ===== get_public_quote: the ONLY way an anonymous visitor can read a quote
-- — looked up by unguessable token, never by id, and never via a direct
-- SELECT on quotes/customers/jobs/businesses (none of which grant anon
-- access). Returns exactly what the public quote page needs to render, in
-- one round trip. =====
create or replace function public.get_public_quote(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  q record;
  c record;
  j record;
  b record;
begin
  select * into q from public.quotes where public_token = p_token;
  if q.id is null then
    return jsonb_build_object('error','not_found');
  end if;

  select name, address, suburb into c from public.customers where id::text = q.lead_id;
  select id, status, details into j from public.jobs where quote_id = q.id::text limit 1;
  select name, phone, email, logo_url, accent_color into b from public.businesses where id = q.business_id;

  return jsonb_build_object(
    'quoteId', q.id,
    'status', q.status,
    'amount', q.amount,
    'createdAt', q.created_at,
    'customer', jsonb_build_object('name', c.name, 'address', c.address, 'suburb', c.suburb),
    'business', jsonb_build_object(
      'name', coalesce(b.name,'Your service provider'), 'phone', b.phone, 'email', b.email,
      'logoUrl', b.logo_url, 'accentColor', b.accent_color
    ),
    'services', coalesce(j.details->'services', '[]'::jsonb),
    'notes', j.details->>'notes',
    'jobStatus', j.status
  );
end;
$$;
revoke all on function public.get_public_quote(uuid) from public;
grant execute on function public.get_public_quote(uuid) to anon, authenticated;

-- ===== respond_to_public_quote: the only write path a customer ever gets.
-- Scoped entirely to the one row their token matches — cannot touch any
-- other quote, job or customer no matter what token/action is sent.
-- 'accept' is idempotent (clicking an already-accepted link is a no-op, not
-- an error) since a customer re-opening an old email is a real scenario. =====
create or replace function public.respond_to_public_quote(p_token uuid, p_action text, p_message text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  q record;
  j_id uuid;
  j_status text;
begin
  if p_action not in ('accept','decline','question') then
    raise exception 'invalid action';
  end if;

  select * into q from public.quotes where public_token = p_token;
  if q.id is null then
    return jsonb_build_object('error','not_found');
  end if;

  select id, status into j_id, j_status from public.jobs where quote_id = q.id::text limit 1;

  if p_action = 'accept' then
    update public.quotes set status = 'accepted' where id = q.id;
    -- Never downgrade a job that's already progressed past "won" (e.g.
    -- already scheduled/completed) — this only ever moves a job forward.
    if j_id is not null and j_status not in ('won','scheduled','completed','paid') then
      update public.jobs set status = 'won' where id = j_id;
    end if;
  elsif p_action = 'decline' then
    update public.quotes set status = 'declined' where id = q.id;
  end if;

  if q.lead_id is not null then
    insert into public.activity_log (business_id, customer_id, job_id, type, summary, detail)
    values (
      q.business_id, q.lead_id::uuid, j_id,
      case p_action when 'accept' then 'quote_accepted' when 'decline' then 'quote_declined' else 'note' end,
      case p_action
        when 'accept' then 'Customer approved their quote online.'
        when 'decline' then 'Customer declined their quote online.'
        else 'Customer asked a question about their quote: "'||coalesce(p_message,'')||'"'
      end,
      case when p_message is not null then jsonb_build_object('message', p_message) else null end
    );
  end if;

  return jsonb_build_object('ok', true, 'status', case p_action when 'accept' then 'accepted' when 'decline' then 'declined' else q.status end);
end;
$$;
revoke all on function public.respond_to_public_quote(uuid,text,text) from public;
grant execute on function public.respond_to_public_quote(uuid,text,text) to anon, authenticated;

-- ===== activity_log hardening: an audit trail that anyone can edit or
-- delete isn't an audit trail. Nothing in the app currently updates or
-- deletes a row here (grep confirms only .insert() calls), so this costs
-- zero existing functionality while closing a real gap — a technician (or
-- anyone with a leaked session) could otherwise alter or erase the record
-- of what happened, including this quote-response history. =====
drop policy if exists "own business" on public.activity_log;
create policy "read own business" on public.activity_log
  for select
  using (business_id = public.current_business_id());
create policy "insert own business" on public.activity_log
  for insert
  with check (business_id = public.current_business_id());
-- Deliberately no update/delete policy for regular clients — matches the
-- import_batches/import_records precedent (schema-import-wizard.sql).
