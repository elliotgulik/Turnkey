-- Auto-handoff for DRAFT (not-yet-approved) quotes, matching the existing
-- auto-handoff behaviour already wired for Won/approved sales below. Until
-- now, auto_handoff only fired on win; a saved draft quote required an
-- explicit "Send quote to ServiceM8"/"Save & send" click every time, even
-- with auto_handoff enabled. This extends the same connection toggle to the
-- moment a *new* immutable quote_versions snapshot is captured for a
-- commercially real, staff-worked (not raw 'new' lead) draft quote.
--
-- Deliberately scoped to content that actually changed: the quote_versions
-- insert below is itself fenced by quote_versions' unique(quote_id,
-- fingerprint) constraint, so an edit that didn't change amount/services/
-- area/customer/business never creates a new snapshot and never re-queues a
-- transfer. The integration_tasks unique(business_id,kind,dedupe_key)
-- constraint keyed on (job id, fingerprint) gives the same guarantee from
-- the other side — at most one queued draft handoff per distinct saved
-- version, safely retried by the existing worker, never duplicated.
create or replace function public.sales_job_audit()
returns trigger language plpgsql security definer set search_path=public as $$
declare q public.quotes; snap jsonb; changed boolean; v_id uuid; v_fingerprint text; v_generation uuid; begin
 if new.quote_id is not null then select * into q from public.quotes where id::text=new.quote_id and business_id=new.business_id for update nowait; end if;
 if tg_op='UPDATE' and exists(select 1 from public.quotes where id::text=old.quote_id and status='accepted') then
  if new.quote_id is distinct from old.quote_id or new.business_id is distinct from old.business_id or new.customer_id is distinct from old.customer_id then raise exception 'Accepted quote is locked'; end if;
  if (coalesce(old.details,'{}')-'salesHistory'-'nextFollowUpAt') is distinct from (coalesce(new.details,'{}')-'salesHistory'-'nextFollowUpAt') then
   -- Freeze only commercial fields. Contacts and sales notes can still be maintained.
   if old.details->'services' is distinct from new.details->'services' or old.details->'total' is distinct from new.details->'total'
      or old.details->'areaPolys' is distinct from new.details->'areaPolys' or old.details->'mapCenter' is distinct from new.details->'mapCenter'
      or old.details->'estimatedCost' is distinct from new.details->'estimatedCost'
      or old.details->'estimatedMarginPct' is distinct from new.details->'estimatedMarginPct'
      or old.details->'gstRegistered' is distinct from new.details->'gstRegistered'
      or old.details->'targetMargin' is distinct from new.details->'targetMargin' then
    raise exception 'Accepted quote is locked. Create a new opportunity for additional work.';
   end if;
  end if;
 end if;
 changed:=tg_op='INSERT';
 if tg_op='UPDATE' then changed:=old.status is distinct from new.status; end if;
 if changed then
  insert into public.sales_events(business_id,job_id,kind,detail) values(new.business_id,new.id,'stage_changed',jsonb_build_object('to',new.status));
 end if;
 if q.id is not null and q.status<>'accepted' then
  snap:=jsonb_build_object('amount',q.amount,'details',new.details,
   'customer',(select to_jsonb(c) from public.customers c where c.id=new.customer_id and c.business_id=new.business_id),
   'business',(select to_jsonb(b) from public.businesses b where b.id=new.business_id));
  v_id:=null; v_fingerprint:=md5(snap::text);
  insert into public.quote_versions(business_id,quote_id,fingerprint,snapshot) values(new.business_id,q.id,v_fingerprint,snap)
   on conflict do nothing returning id into v_id;
  if v_id is not null and q.amount>0 and new.status not in ('new','cancelled','won','scheduled','completed','paid') then
   select generation into v_generation from public.servicem8_connections where business_id=new.business_id and auto_handoff;
   if v_generation is not null then
    -- Same dedupe_key shape as the explicit POST /handoff route
    -- ([job.id, generation, mode, fingerprint]) so a manual "Save & send"
    -- click for the very same saved version collapses onto this already-
    -- queued task instead of creating a second one.
    insert into public.integration_tasks(business_id,kind,dedupe_key,payload) values(new.business_id,'handoff',new.id::text||':'||v_generation::text||':quote:'||v_fingerprint,
     jsonb_build_object('jobId',new.id,'mode','quote','generation',v_generation,'quoteId',q.id,'versionId',v_id,'fingerprint',v_fingerprint,'snapshot',snap))
    on conflict do nothing;
   end if;
  end if;
 end if;
 if new.status='won' and exists(select 1 from public.servicem8_connections where business_id=new.business_id and auto_handoff) then
  insert into public.integration_tasks(business_id,kind,dedupe_key,payload) values(new.business_id,'handoff',new.id::text,jsonb_build_object('jobId',new.id)) on conflict do nothing;
 end if;
 return new;
end $$;
revoke all on function public.sales_job_audit() from public,anon,authenticated;
