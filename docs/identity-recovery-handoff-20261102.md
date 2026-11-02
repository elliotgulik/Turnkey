# Additional profile recovery — verified 3 November 2026

This follow-up supersedes the remaining counts in the earlier pass below.

Parent final action: the user-requested testing-record cleanup was subsequently
applied as reversible soft archive flags to 29 jobs and 11 intake submissions.
No rows were deleted or relinked. Historical review notes below predate that
action; the release report records its scope and the protecting migration.

- Applied **266 customer updates / 641 missing fields**: **190 names, 100 emails, 160 phones, 191 addresses**. Existing populated values preserved byte-for-byte in this pass.
- Jobs remain **861**. Blank-name customer links **209 → 19**. Of the remaining 19, **18 lack ServiceM8 UUIDs**; 1 has a ServiceM8 UUID. All 19 lack job.details.name and job.details.address. Fresh evidence query returned **0 remaining eligible contact fields**.
- Added exact current-generation `external_object_mappings.object_type='job'` snapshot.profile evidence: tenant equality, `local_id=jobs.id::text`, `external_uuid::text=details.serviceM8JobUuid`, `connection_generation=servicem8_connections.generation`. Profile personName/email/phone/address read directly. Added same-job details.name/address for older imports.
- Retained the prior lead/quote/company/completed snapshot evidence in consistency checking across each customer's attached jobs. Rejected generic fallback names, including ServiceM8 booking. Every changed field had one distinct nonblank value; no stage, price, job, schema, credential or deletion changes.
- Correction to previous scope claim: the first pass had exhausted only its inspected evidence joins; job.snapshot.profile had been omitted and supplied substantial additional exact evidence.

## Test review refinement — no deletions

The 11 lead candidates are separate from customer/job records. Their external_id is null; no job externalId matched either a nonempty lead external_id or the decimal lead ID. Exact customer name/address equality is a review criterion only, not proof that a particular lead owns those jobs.

| Lead IDs | Exact name/address customer records | Jobs attached to those customers |
| --- | ---: | ---: |
| 4 | 1 | 1 |
| 6 | 1 | 1 |
| 8 | 1 | 1 |
| 13, 17, 18, 23 (same shared match set) | 5 | 4 |
| 14 | 1 | 1 |
| 15 | 1 | 3 |
| 16 | 1 | 1 |
| 19 | 1 | 1 |

Shared rows must not be summed repeatedly. The broader user-specified name/address customer criteria match **23 customer records and 29 attached jobs**. Contact values were inspected in live query output, not copied into this document. No records removed or relinked; parent decision remains pending.

## Additional executed SQL

Returned 266 customer rows and field counts above; verified by fresh production reads. No broad tests.

```sql
with evidence as (
select j.customer_id cid,l.payload->'customer' obj,'lead' src from jobs j join leads l on l.business_id=j.business_id and l.external_id=j.details->>'externalId' where j.business_id='041e386f-beeb-4dd8-a515-e4293629a921' and nullif(l.external_id,'') is not null
union all select j.customer_id,q.snapshot->'customer','quote' from jobs j join quote_versions q on q.business_id=j.business_id and q.quote_id::text=j.quote_id where j.business_id='041e386f-beeb-4dd8-a515-e4293629a921' and q.snapshot->'customer'->>'id'=j.customer_id::text
union all select c.id,m.snapshot,'company' from customers c join external_object_mappings m on m.business_id=c.business_id and m.local_id=c.id::text and m.object_type='company' where c.business_id='041e386f-beeb-4dd8-a515-e4293629a921'
union all select j.customer_id,jsonb_build_object('name',m.snapshot->>'personName','email',m.snapshot->>'email','phone',m.snapshot->>'phone','address',m.snapshot->>'address'),'completed_job' from jobs j join external_object_mappings m on m.business_id=j.business_id and m.object_type='completed_job' and m.external_uuid::text=j.details->>'serviceM8JobUuid' and m.snapshot->>'jobUuid'=m.external_uuid::text where j.business_id='041e386f-beeb-4dd8-a515-e4293629a921'
union all select j.customer_id,jsonb_build_object('name',m.snapshot->'profile'->>'personName','email',m.snapshot->'profile'->>'email','phone',m.snapshot->'profile'->>'phone','address',m.snapshot->'profile'->>'address'),'job_profile'
from jobs j join external_object_mappings m on m.business_id=j.business_id and m.local_id=j.id::text and m.object_type='job' and m.external_uuid::text=j.details->>'serviceM8JobUuid'
join servicem8_connections sc on sc.business_id=m.business_id and sc.generation=m.connection_generation
where j.business_id='041e386f-beeb-4dd8-a515-e4293629a921'
union all select j.customer_id,jsonb_build_object('name',j.details->>'name','address',j.details->>'address'),'job_details' from jobs j where j.business_id='041e386f-beeb-4dd8-a515-e4293629a921'
),fields as(select cid,src,k,nullif(btrim(obj->>k),'') v from evidence cross join unnest(array['name','email','phone','address','suburb']) k), proven as(select cid,k,min(v) v,count(distinct v) variants from fields where v is not null and lower(v) not in ('servicem8 booking','service m8 booking','a customer','customer','unknown') group by cid,k)
, patches as (
select p.cid,jsonb_object_agg(p.k,p.v) patch from proven p join customers c on c.id=p.cid
where p.variants=1 and coalesce(btrim(to_jsonb(c)->>p.k),'')='' group by p.cid
), updated as (
update customers c set
name=case when nullif(btrim(c.name),'') is null then coalesce(p.patch->>'name',c.name) else c.name end,
email=case when nullif(btrim(c.email),'') is null then coalesce(p.patch->>'email',c.email) else c.email end,
phone=case when nullif(btrim(c.phone),'') is null then coalesce(p.patch->>'phone',c.phone) else c.phone end,
address=case when nullif(btrim(c.address),'') is null then coalesce(p.patch->>'address',c.address) else c.address end,
suburb=case when nullif(btrim(c.suburb),'') is null then coalesce(p.patch->>'suburb',c.suburb) else c.suburb end
from patches p where c.id=p.cid and c.business_id='041e386f-beeb-4dd8-a515-e4293629a921'
and coalesce(nullif(btrim(c.name),''),p.patch->>'name') is not null
returning c.id,p.patch
) select count(*) customer_rows,jsonb_build_object('name',count(*) filter(where patch ? 'name'),'email',count(*) filter(where patch ? 'email'),'phone',count(*) filter(where patch ? 'phone'),'address',count(*) filter(where patch ? 'address'),'suburb',count(*) filter(where patch ? 'suburb')) fields from updated;
```

---

# Verified production recovery — 3 November 2026 (NZ)

Project `rcighpmdrutnghsqhzlr`; business `041e386f-beeb-4dd8-a515-e4293629a921`.

This status supersedes the historical handoff below.

- Applied recovery to **22 customers / 52 missing fields**: 12 names, 10 emails, 16 phones, 12 addresses, 2 suburbs.
- Jobs unchanged at **861**. Blank-linked jobs **222 → 209**, distinct linked blank customers **221 → 209**, missing customer rows **0**.
- Customer rows unchanged at **14,371**; completely blank profiles **12,343 → 12,331**. Missing email **13,367 → 13,357**; phone **13,570 → 13,554**; address **12,539 → 12,527**.
- Of the 209 remaining blank-linked jobs, 191 have ServiceM8 job UUIDs and 18 do not. There are 12,122 blank customer rows with no linked job; untouched.
- Exact evidence only: tenant-scoped job externalId to lead external_id; job quote_id plus identical snapshot customer ID; company mapping local_id to customer ID; ServiceM8 completed snapshot external_uuid to job serviceM8JobUuid with snapshot jobUuid cross-check.
- Each restored field had exactly one distinct nonblank trimmed value across all inspected evidence. No conflicting eligible fields; **0 remaining eligible missing contact fields** on fresh verification. Used explicit personName from completed snapshots, never inferred a person from a company.
- Previously flagged shared customer: 30 quote versions across two jobs agree on contact fields. Payload differences are added followups_disabled metadata, not contact conflicts.
- **Two missing job forms restored**, including requestedServices. Saved leads 406/407/408 now all match job formAnswers exactly; selected-service counts 3/2/1. No saved urgency values exist, so **0 urgency restored**, none invented.
- Other job fields unchanged (verified in update RETURNING), except automatic updated_at. No stage, price, deletion, credential or schema changes. Populated customer values retained semantically; executed SQL trims surrounding whitespace in populated contact fields on touched rows.
- Identity and intake guards confirmed enabled.
- ServiceM8 import task `7eb966ac-ed31-46bd-a8ee-f8e9aa4fb6cb` **succeeded**, attempt 3, completed `2026-11-02T07:15:33.189Z`, no last_error. Full accounting not audited.
- Additional recovery needs original ServiceM8 contact/company evidence or backups. No guessing or broad tests. Deployment checks remain outside this SQL-only pass.

## Test-lead review, no removal

**11 matching lead IDs:** 4, 6, 8, 13, 14, 15, 16, 17, 18, 19, 23. All match the user-specified address criterion; 13/17/18/23 also match the first-name criterion. All external_id values are null. No contact values saved here. Parent/user decision required before deletion.

## Executed recovery SQL

Both statements executed once, followed by fresh verification. First returned 22 customer rows, second returned 2 jobs with other_job_fields_unchanged=true.

```sql
with evidence as (
select j.customer_id cid,l.payload->'customer' obj,'lead' src from jobs j join leads l on l.business_id=j.business_id and l.external_id=j.details->>'externalId' where j.business_id='041e386f-beeb-4dd8-a515-e4293629a921' and nullif(l.external_id,'') is not null
union all select j.customer_id,q.snapshot->'customer','quote' from jobs j join quote_versions q on q.business_id=j.business_id and q.quote_id::text=j.quote_id where j.business_id='041e386f-beeb-4dd8-a515-e4293629a921' and q.snapshot->'customer'->>'id'=j.customer_id::text
union all select c.id,m.snapshot,'company' from customers c join external_object_mappings m on m.business_id=c.business_id and m.local_id=c.id::text and m.object_type='company' where c.business_id='041e386f-beeb-4dd8-a515-e4293629a921'
union all select j.customer_id,jsonb_build_object('name',m.snapshot->>'personName','email',m.snapshot->>'email','phone',m.snapshot->>'phone','address',m.snapshot->>'address'),'completed_job' from jobs j join external_object_mappings m on m.business_id=j.business_id and m.object_type='completed_job' and m.external_uuid::text=j.details->>'serviceM8JobUuid' and m.snapshot->>'jobUuid'=m.external_uuid::text where j.business_id='041e386f-beeb-4dd8-a515-e4293629a921'
),fields as(select cid,src,k,nullif(btrim(obj->>k),'') v from evidence cross join unnest(array['name','email','phone','address','suburb']) k), proven as(select cid,k,min(v) v,count(distinct v) variants from fields where v is not null group by cid,k)
, patches as (
select p.cid,jsonb_object_agg(p.k,p.v) patch from proven p join customers c on c.id=p.cid
where p.variants=1 and coalesce(btrim(to_jsonb(c)->>p.k),'')='' group by p.cid
), updated as (
update customers c set
name=coalesce(nullif(btrim(c.name),''),p.patch->>'name',c.name),
email=coalesce(nullif(btrim(c.email),''),p.patch->>'email',c.email),
phone=coalesce(nullif(btrim(c.phone),''),p.patch->>'phone',c.phone),
address=coalesce(nullif(btrim(c.address),''),p.patch->>'address',c.address),
suburb=coalesce(nullif(btrim(c.suburb),''),p.patch->>'suburb',c.suburb)
from patches p where c.id=p.cid and c.business_id='041e386f-beeb-4dd8-a515-e4293629a921'
and coalesce(nullif(btrim(c.name),''),p.patch->>'name') is not null
returning c.id,p.patch
) select count(*) customer_rows,jsonb_build_object('name',count(*) filter(where patch ? 'name'),'email',count(*) filter(where patch ? 'email'),'phone',count(*) filter(where patch ? 'phone'),'address',count(*) filter(where patch ? 'address'),'suburb',count(*) filter(where patch ? 'suburb')) fields from updated;
```

```sql
with evidence as (
select j.id,l.payload from jobs j join leads l on l.business_id=j.business_id and l.external_id=j.details->>'externalId'
where j.business_id='041e386f-beeb-4dd8-a515-e4293629a921' and nullif(l.external_id,'') is not null
), fields as (
select id,k,payload->k v from evidence cross join unnest(array['formAnswers','requestedServices','urgency']) k
where payload->k is not null and payload->k not in ('null'::jsonb,'[]'::jsonb,'""'::jsonb,'{}'::jsonb)
), proven as(select id,k,min(v::text)::jsonb v from fields group by id,k having count(distinct v)=1),
patches as(select j.id,jsonb_object_agg(p.k,case when p.k='requestedServices' then (select jsonb_agg(case when jsonb_typeof(s)='string' then jsonb_build_object('name',s#>>'{}','service_id',null) else s end) from jsonb_array_elements(p.v) s) else p.v end) patch,
to_jsonb(j)-'updated_at'-'details' header,j.details-'formAnswers'-'requestedServices'-'urgency' protected_details
from jobs j join proven p on p.id=j.id where j.business_id='041e386f-beeb-4dd8-a515-e4293629a921'
and (j.details->p.k is null or j.details->p.k in ('null'::jsonb,'[]'::jsonb,'""'::jsonb,'{}'::jsonb))
group by j.id), updated as(
update jobs j set details=coalesce(j.details,'{}'::jsonb)||p.patch from patches p where j.id=p.id and j.business_id='041e386f-beeb-4dd8-a515-e4293629a921'
returning j.id,p.patch,(to_jsonb(j)-'updated_at'-'details'=p.header and j.details-'formAnswers'-'requestedServices'-'urgency'=p.protected_details) protected_unchanged)
select count(*) job_rows,count(*) filter(where patch ? 'formAnswers') form_answers,count(*) filter(where patch ? 'requestedServices') requested_services,count(*) filter(where patch ? 'urgency') urgency,bool_and(protected_unchanged) other_job_fields_unchanged from updated;
```

---

# Emergency customer identity recovery — 2 November 2026 (historical)

## Shipped

- `9051a90`: complete Wix form-answer retention, customer/profile display, selected-service precedence. Netlify and Render confirmed live. 71 focused checks and production-page browser checks at 1440/390/360px passed.
- `04aed5f`: paginate customer/job/invoice reads; exclude empty customer placeholders from hydration; retain a missing customer's original UUID; reject writes from incomplete records; suppress autosaving during database hydration. Seven tenant/hydration checks passed and static build passed.
- Migration `20261102064713_protect_lead_identity_and_form_answers.sql` applied to production: block blank customer saves, block replacing a job's customer with an empty profile, retain submitted answers/selections when stale clients omit them.
- Recovered **364** completely blank customer rows from unique exact `jobs.details.externalId = leads.external_id` matches, scoped to one business and requiring consistent evidence for every attached job. No fuzzy matching, deletions, stage changes or price changes.
- Restored the owner's three supplied Wix submissions in lead payloads. Correction: the attempted job reapplication after protection FAILED when usage ran out. Two job forms remained missing until the verified recovery above.

## Still unfinished — do not claim a full recovery

- Verify deployment of `04aed5f` on Netlify and Render. Push succeeded; user requested immediate save/push before usage ran out.
- Inspect remaining blank-linked jobs and recover only from exact evidence. Before the 364-row recovery, 586 of 685 jobs referenced blank profiles. This does not prove the remaining jobs all have recoverable identities.
- Two jobs share a blank customer whose quote snapshots contain differing contact payloads. Inspect field conflicts before restoring; never arbitrarily choose a quote version.
- Thousands of blank orphan customer rows were generated before the fix. They were **not deleted**. Review separately with owner approval before cleanup.
- ServiceM8 full-import task `7eb966ac-ed31-46bd-a8ee-f8e9aa4fb6cb` last observed running on attempt 2 with a prior generic database/integration error. Full completion and accounting remain unverified.
- Confirm a fresh real Wix submission through the provider. Local tests cover supplied form layouts, but cannot recover historical answers omitted from webhook payloads unless supplied by the owner/source.

## Resume safely

1. Keep the database identity guard enabled. Old open browser tabs must not create additional blank profiles.
2. Check production deployments and refresh TurnKey once after the loader release is live.
3. Query current blank-linked counts; use lead external IDs, quote IDs and explicit external mappings only for recovery.
4. Check ServiceM8 import task and logs; do not blindly rerun bulk imports or change statuses.
5. Preserve accepted commercial quote snapshots, real customer contact fields, original lead source and form answers.

No ad generated. Automatic customer follow-up sending remains disabled.

## Parent follow-up in the 3 November release

- Database-backed test archive applied: **29 jobs and 11 intake submissions** matched the owner's explicit Elliot / 30 Eversleigh criteria. Jobs, accepted quotes and contacts were retained; stages/prices unchanged. `testLeadArchivedAt` marks the records. New frontend/server metrics exclude these marked jobs. The archive is reversible by removing its two detail keys through an authorised backend/admin repair; no rows were deleted.
- Applied migration `20261102113209_preserve_testing_lead_archive.sql` so an older authenticated browser cannot silently remove the archive flag. Intake rows were acknowledged to prevent accidental re-ingestion.
- Added frontend precedence for authoritative customer identity over blank historic job snapshots. Missing profiles keep their UUID and remain write-protected.
- Added missing-field-only repair during the existing automatic ServiceM8 reconciliation, using the exact already-linked upstream profile. Concurrent operator edits win. Deployment is required for this additional repair behavior.
