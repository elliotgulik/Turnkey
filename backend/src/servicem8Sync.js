// Outbound TurnKey -> ServiceM8 handoff: pure, dependency-injected decision
// logic (no Express, no real Supabase/ServiceM8 client), so it's directly
// unit-testable — see servicem8Sync.test.js. The route handler in
// servicem8Routes.js supplies the real implementations of every injected
// function.
//
// Idempotency strategy: servicem8_object_map remembers which TurnKey
// customer/job already has a ServiceM8 Company/Job, and servicem8_handoffs
// remembers the outcome per TurnKey job. A repeated "Won" event for the
// same job either no-ops immediately (already synced) or resumes from
// wherever the previous attempt left off (e.g. Company created but Job
// creation failed) — it never creates a second Company or Job for work
// that's already been handed off.

export async function performServiceM8Handoff({
  businessId,
  jobId,
  customer,     // { id, name, email, phone, address }
  job,          // { address, description }
  materials,    // [{ name, cost, price, quantity }] — optional, best-effort
  quotePdf,     // { filename, fileBytes, mimeType } — optional, best-effort
  deps
}) {
  const {
    getExistingHandoff,     // async (businessId, jobId) -> handoff row | null
    getObjectMap,           // async (businessId, localType, localId, sm8Type) -> row | null
    saveObjectMap,          // async (row) -> void
    saveHandoff,            // async (row) -> void (upsert on business_id+job_id)
    createCompany,          // async ({name,email,phone,address}) -> { recordUuid }
    createJob,               // async ({companyUuid,jobAddress,description}) -> { recordUuid }
    createJobMaterial,       // async ({jobUuid,name,cost,price,quantity}) -> { recordUuid }
    attachFile               // async ({jobUuid,filename,fileBytes,mimeType}) -> { recordUuid }
  } = deps

  const existing = await getExistingHandoff(businessId, jobId)
  if (existing && existing.status === 'synced' && existing.sm8_job_uuid) {
    return { status: 'synced', skipped: true, companyUuid: existing.sm8_company_uuid, jobUuid: existing.sm8_job_uuid }
  }

  const attempts = (existing?.attempts || 0) + 1
  const warnings = []

  try {
    let companyUuid = existing?.sm8_company_uuid || null
    if (!companyUuid) {
      const companyMap = await getObjectMap(businessId, 'customer', customer.id, 'company')
      companyUuid = companyMap?.sm8_uuid || null
    }
    if (!companyUuid) {
      const created = await createCompany({ name: customer.name, email: customer.email, phone: customer.phone, address: customer.address })
      if (!created?.recordUuid) throw new Error('ServiceM8 did not return a company uuid')
      companyUuid = created.recordUuid
      await saveObjectMap({ business_id: businessId, local_type: 'customer', local_id: customer.id, sm8_type: 'company', sm8_uuid: companyUuid })
    }

    let jobUuid = existing?.sm8_job_uuid || null
    if (!jobUuid) {
      const jobMap = await getObjectMap(businessId, 'job', jobId, 'job')
      jobUuid = jobMap?.sm8_uuid || null
    }
    if (!jobUuid) {
      const created = await createJob({ companyUuid, jobAddress: job.address, description: job.description })
      if (!created?.recordUuid) throw new Error('ServiceM8 did not return a job uuid')
      jobUuid = created.recordUuid
      await saveObjectMap({ business_id: businessId, local_type: 'job', local_id: jobId, sm8_type: 'job', sm8_uuid: jobUuid })
    }

    // Line items and the quote PDF are best-effort — the handoff itself
    // (a real Job existing in ServiceM8, linked to the right Company) is
    // the part that must succeed; a failure attaching a nice-to-have
    // shouldn't flip an otherwise-successful handoff to "failed" and
    // trigger pointless Company/Job re-creation attempts on retry.
    for (const m of (materials || [])) {
      try {
        await createJobMaterial({ jobUuid, name: m.name, cost: m.cost, price: m.price, quantity: m.quantity ?? 1 })
      } catch (err) {
        warnings.push(`Line item "${m.name}" failed to sync: ${err.message}`)
      }
    }
    if (quotePdf) {
      try {
        await attachFile({ jobUuid, filename: quotePdf.filename, fileBytes: quotePdf.fileBytes, mimeType: quotePdf.mimeType })
      } catch (err) {
        warnings.push(`Quote PDF failed to attach: ${err.message}`)
      }
    }

    await saveHandoff({ business_id: businessId, job_id: jobId, status: 'synced', sm8_company_uuid: companyUuid, sm8_job_uuid: jobUuid, attempts, last_error: null })
    return { status: 'synced', companyUuid, jobUuid, warnings }
  } catch (err) {
    await saveHandoff({
      business_id: businessId, job_id: jobId, status: 'failed',
      sm8_company_uuid: existing?.sm8_company_uuid || null, sm8_job_uuid: existing?.sm8_job_uuid || null,
      attempts, last_error: err.message
    })
    return { status: 'failed', error: err.message }
  }
}
