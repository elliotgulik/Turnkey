-- Adds real per-business customization for the customer-facing quote/invoice
-- experience and a genuine "Policies & Terms" system, replacing two gaps:
--
-- 1) Only `accent_color` was ever persisted server-side for branding (see
--    schema-branding.sql) — logo/name/phone/email already existed, but there
--    was no primary colour (distinct from accent), no font/header style
--    choice, and no per-business quote intro message. Every business's
--    public quote page looked structurally identical.
--
-- 2) There was no per-business terms/policies storage at all. booking.html's
--    quote-request form has always shown a hardcoded
--    "I agree to Turnkey's Terms & Conditions" checkbox — every customer of
--    every business saw TurnKey's name in that checkbox, never the actual
--    business they were requesting a quote from, because there was nothing
--    in the schema to source a business's own wording from.
--
-- policies_config is a jsonb blob (same established pattern as
-- pricing_config/workflow_config) holding:
--   { quoteTerms, cancellationPolicy, paymentTerms, warrantyInfo,
--     additionalNotes, customerAgreementWording }
-- Deliberately separate from docTemplate's existing quoteTerms/invoiceTerms
-- (index.html, PDF/email-facing, operator-only) — this is the customer-
-- facing counterpart shown on booking.html and quote.html.
--
-- Safe to re-run: idempotent.

alter table public.businesses add column if not exists primary_color text;
alter table public.businesses add column if not exists font_style text;
alter table public.businesses add column if not exists header_style text;
alter table public.businesses add column if not exists quote_intro_message text;
alter table public.businesses add column if not exists policies_config jsonb;

-- ===== get_public_quote: extend with the fields quote.html needs to render
-- the business's own branding/terms instead of generic copy. Full function
-- body is repeated here (create or replace) since Postgres has no ALTER for
-- a function's return expression — this must stay byte-for-byte identical
-- to schema-public-quote.sql's version except for the additions marked below,
-- or the two files will silently drift out of sync. =====
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
  v_services jsonb;
begin
  select * into q from public.quotes where public_token = p_token;
  if q.id is null then
    return jsonb_build_object('error','not_found');
  end if;

  select name, address, suburb into c from public.customers where id::text = q.lead_id;
  select id, status, details into j from public.jobs where quote_id = q.id::text limit 1;
  -- Added: primary_color, font_style, header_style, quote_intro_message, policies_config
  select name, phone, email, logo_url, accent_color,
         primary_color, font_style, header_style, quote_intro_message, policies_config
    into b from public.businesses where id = q.business_id;

  select coalesce(jsonb_agg(elem - 'recommendedPrice' - 'estCost'), '[]'::jsonb)
    into v_services
    from jsonb_array_elements(coalesce(j.details->'services', '[]'::jsonb)) elem;

  return jsonb_build_object(
    'quoteId', q.id,
    'quoteNumber', 'Q-'||upper(right(q.id::text, 6)),
    'status', q.status,
    'amount', q.amount,
    'createdAt', q.created_at,
    'validUntil', q.created_at + interval '30 days',
    'estimatedDurationMin', j.details->>'estimatedDurationMin',
    'customer', jsonb_build_object('name', c.name, 'address', c.address, 'suburb', c.suburb),
    'business', jsonb_build_object(
      'name', coalesce(b.name,'Your service provider'), 'phone', b.phone, 'email', b.email,
      'logoUrl', b.logo_url, 'accentColor', b.accent_color,
      'primaryColor', b.primary_color, 'fontStyle', b.font_style, 'headerStyle', b.header_style,
      'quoteIntroMessage', b.quote_intro_message, 'policies', b.policies_config
    ),
    'services', v_services,
    'notes', j.details->>'notes',
    'jobStatus', j.status,
    'areaPolys', coalesce(j.details->'areaPolys', '[]'::jsonb),
    'mapCenter', j.details->'mapCenter'
  );
end;
$$;

revoke all on function public.get_public_quote(uuid) from public;
grant execute on function public.get_public_quote(uuid) to anon, authenticated;
