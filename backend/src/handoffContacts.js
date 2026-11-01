// All adapters are bound by the caller to one business/connection generation.
// customer must be the current business-owned customer, not a quote snapshot.
const text = value => typeof value === 'string' ? value.trim() : ''
const active = row => row.active == null || ![0, '0', false].includes(row.active)
const conflict = message => Object.assign(new Error(message), { status: 409, publicMessage: message })
const contactType = value => ({ 'Job Contact': 'JOB', 'Billing Contact': 'BILLING' })[value] || value
const phoneKey = value => text(value).replace(/\D/g, '')

function fullAddress(customer) {
  const address = text(customer.address)
  const suburb = text(customer.suburb)
  const words = value => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return address && suburb && !(` ${words(address)} `).includes(` ${words(suburb)} `)
    ? `${address}, ${suburb}` : address
}

function contactFields(customer) {
  const fields = {}
  const name = text(customer.name)
  if (name) {
    const [first, ...last] = name.split(/\s+/)
    fields.first = first
    fields.last = last.join(' ')
  }
  if (text(customer.email)) fields.email = text(customer.email)
  const phone = text(customer.phone) || text(customer.mobile)
  const mobile = text(customer.mobile) || text(customer.phone)
  if (phone) fields.phone = phone
  if (mobile) fields.mobile = mobile
  return fields
}

function validate(row, parentField, parentUuid, type, resource) {
  if (!row || row[parentField] !== parentUuid || contactType(row.type) !== type || !active(row)) {
    throw conflict(`ServiceM8 ${resource} ${type} contact has a different parent/type or is inactive. Review its mapping before retrying.`)
  }
}

function selectContact(rows, parentField, parentUuid, type, customer, resource) {
  if (!Array.isArray(rows)) throw new Error(`ServiceM8 ${resource} list returned invalid data`)
  const candidates = rows.filter(row => row && active(row) && row[parentField] === parentUuid && contactType(row.type) === type)
  const email = text(customer.email).toLowerCase()
  const phones = new Set([phoneKey(customer.phone), phoneKey(customer.mobile)].filter(Boolean))
  const matches = candidates.filter(row =>
    (email && text(row.email).toLowerCase() === email) ||
    [phoneKey(row.phone), phoneKey(row.mobile)].some(value => value && phones.has(value)))
  const selected = matches.length === 1 ? matches[0] : matches.length === 0 && candidates.length === 1 ? candidates[0] : null
  if (matches.length > 1 || (!selected && candidates.length > 1)) {
    throw conflict(`Multiple ServiceM8 ${resource} ${type} contacts match this customer or lack a unique identity. Select/merge the intended contact in ServiceM8, then retry.`)
  }
  if (selected && !text(selected.uuid)) throw new Error(`ServiceM8 ${resource} contact is missing its UUID`)
  return selected
}

async function getOptional(request, path) {
  try { return (await request(path, { method: 'GET' })).data }
  catch (error) { if (error.status !== 404) throw error; return null }
}

async function updateChanged(request, path, existing, desired) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new Error(`ServiceM8 ${path} returned invalid data`)
  }
  const changes = Object.fromEntries(Object.entries(desired).filter(([key, value]) => String(existing[key] ?? '') !== String(value)))
  // ServiceM8 record POSTs are partial updates: unknown fields stay untouched.
  if (Object.keys(changes).length) await request(path, { method: 'POST', body: changes })
}

/**
 * Sync company details and explicit JOB + BILLING contacts for company and job.
 * request(path, {method, body?}) -> {data}; API errors must carry .status.
 * mapping(type, localId) -> {external_uuid, synced_at?} reserves a stable UUID.
 * adopt(type, localId, externalUuid) persists a discovered UUID before writes.
 * markSynced(type, localId) stamps completion. All callbacks may be async.
 * Returns {companyUuid, jobUuid}; failures propagate to the handoff worker.
 */
export async function syncHandoffContacts({ companyUuid, jobUuid, customer, request, mapping, adopt, markSynced }) {
  if (!companyUuid || !jobUuid || !customer?.id) throw new Error('Company UUID, job UUID and current customer ID are required')
  for (const callback of [request, mapping, adopt, markSynced]) {
    if (typeof callback !== 'function') throw new TypeError('Contact sync requires request, mapping, adopt and markSynced callbacks')
  }
  const companyPath = `/company/${encodeURIComponent(companyUuid)}.json`
  const company = (await request(companyPath, { method: 'GET' })).data
  const address = fullAddress(customer)
  const companyFields = {}
  if (text(customer.name)) companyFields.name = text(customer.name)
  if (address) companyFields.address = address
  const billingAddress = text(customer.billing_address) || (!text(company?.billing_address) ? address : '')
  if (billingAddress) companyFields.billing_address = billingAddress
  await updateChanged(request, companyPath, company, companyFields)

  const completed = [['company', customer.id]]
  for (const resource of ['companycontact', 'jobcontact']) {
    const parentField = resource === 'companycontact' ? 'company_uuid' : 'job_uuid'
    const parentUuid = resource === 'companycontact' ? companyUuid : jobUuid
    let discovered
    for (const type of ['JOB', 'BILLING']) {
      const localId = resource === 'companycontact'
        ? `${customer.id}${type === 'JOB' ? '' : ':billing'}`
        : `${jobUuid}:${type === 'JOB' ? 'job' : 'billing'}`
      const map = await mapping(resource, localId)
      if (!text(map?.external_uuid)) throw new Error(`Missing reserved UUID for ${resource} ${localId}`)
      let uuid = map.external_uuid
      const recordPath = () => `/${resource}/${encodeURIComponent(uuid)}.json`
      let existing = await getOptional(request, recordPath())
      if (!existing && !map.synced_at) {
        if (!discovered) {
          const filter = `${parentField} eq '${String(parentUuid).replace(/'/g, "''")}'`
          discovered = (await request(`/${resource}.json?$filter=${encodeURIComponent(filter)}`, { method: 'GET' })).data
        }
        existing = selectContact(discovered, parentField, parentUuid, type, customer, resource)
        if (existing) {
          uuid = existing.uuid
          await adopt(resource, localId, uuid)
          // Re-read adopted records to validate current parent/type before writes.
          existing = (await request(recordPath(), { method: 'GET' })).data
        }
      }
      const desired = { [parentField]: parentUuid, type, ...contactFields(customer) }
      if (resource === 'companycontact') desired.is_primary_contact = type === 'JOB' ? '1' : '0'
      if (!existing) {
        try {
          await request(`/${resource}.json`, { method: 'POST', body: { uuid, active: 1, ...desired } })
          existing = desired
        } catch (error) {
          if (error.status !== 409) throw error
          // A previous ambiguous POST may have succeeded. Never pick a new UUID.
          existing = (await request(recordPath(), { method: 'GET' })).data
        }
      }
      validate(existing, parentField, parentUuid, type, resource)
      await updateChanged(request, recordPath(), existing, desired)
      completed.push([resource, localId])
    }
  }
  // No success stamps until all required remote writes have succeeded.
  for (const [type, localId] of completed) await markSynced(type, localId)
  return { companyUuid, jobUuid }
}
