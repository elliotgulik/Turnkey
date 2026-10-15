import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { performServiceM8Handoff } from './servicem8Sync.js'

function baseArgs(overrides = {}) {
  const objectMaps = {}
  const handoffs = {}
  const calls = { createCompany: 0, createJob: 0, createJobMaterial: 0, attachFile: 0 }
  const deps = {
    getExistingHandoff: async (bizId, jobId) => handoffs[`${bizId}:${jobId}`] || null,
    getObjectMap: async (bizId, localType, localId, sm8Type) => objectMaps[`${bizId}:${localType}:${localId}:${sm8Type}`] || null,
    saveObjectMap: async (row) => { objectMaps[`${row.business_id}:${row.local_type}:${row.local_id}:${row.sm8_type}`] = row },
    saveHandoff: async (row) => { handoffs[`${row.business_id}:${row.job_id}`] = row },
    createCompany: async () => { calls.createCompany++; return { recordUuid: 'company-uuid-1' } },
    createJob: async () => { calls.createJob++; return { recordUuid: 'job-uuid-1' } },
    createJobMaterial: async () => { calls.createJobMaterial++; return { recordUuid: 'material-uuid-1' } },
    attachFile: async () => { calls.attachFile++; return { recordUuid: 'attachment-uuid-1' } },
    ...overrides.deps
  }
  return {
    businessId: 'biz-1',
    jobId: 'job-1',
    customer: { id: 'cust-1', name: 'Jane Doe', email: 'jane@example.com', phone: '0211234567', address: '1 Test St' },
    job: { address: '1 Test St', description: 'House wash' },
    materials: [{ name: 'House wash', cost: 50, price: 150, quantity: 1 }],
    quotePdf: { filename: 'quote.pdf', fileBytes: Buffer.from('fake'), mimeType: 'application/pdf' },
    ...overrides,
    deps,
    _calls: calls,
    _objectMaps: objectMaps,
    _handoffs: handoffs
  }
}

describe('performServiceM8Handoff', () => {
  test('fresh handoff creates a company, a job, line items and attaches the quote', async () => {
    const args = baseArgs()
    const result = await performServiceM8Handoff(args)
    assert.equal(result.status, 'synced')
    assert.equal(result.companyUuid, 'company-uuid-1')
    assert.equal(result.jobUuid, 'job-uuid-1')
    assert.equal(args._calls.createCompany, 1)
    assert.equal(args._calls.createJob, 1)
    assert.equal(args._calls.createJobMaterial, 1)
    assert.equal(args._calls.attachFile, 1)
    assert.equal(args._handoffs['biz-1:job-1'].status, 'synced')
  })

  test('a job already fully synced is skipped entirely — no API calls, no duplicate job', async () => {
    const args = baseArgs()
    args.deps.getExistingHandoff = async () => ({ status: 'synced', sm8_company_uuid: 'company-uuid-1', sm8_job_uuid: 'job-uuid-1', attempts: 1 })
    const result = await performServiceM8Handoff(args)
    assert.equal(result.status, 'synced')
    assert.equal(result.skipped, true)
    assert.equal(args._calls.createCompany, 0)
    assert.equal(args._calls.createJob, 0)
  })

  test('a repeated Won event for an already-synced job never creates a second ServiceM8 job (idempotency guarantee)', async () => {
    const args = baseArgs()
    const first = await performServiceM8Handoff(args)
    assert.equal(first.status, 'synced')
    // Simulate the event firing again — same businessId/jobId, fresh call,
    // but getExistingHandoff now returns what the first call just saved.
    const second = await performServiceM8Handoff(args)
    assert.equal(second.status, 'synced')
    assert.equal(second.jobUuid, first.jobUuid)
    assert.equal(args._calls.createCompany, 1) // still only ever called once
    assert.equal(args._calls.createJob, 1)
  })

  test('resumes from a partial failure (company created, job creation failed) without recreating the company', async () => {
    const args = baseArgs()
    args.deps.getExistingHandoff = async () => ({ status: 'failed', sm8_company_uuid: 'company-uuid-1', sm8_job_uuid: null, attempts: 1, last_error: 'timeout' })
    const result = await performServiceM8Handoff(args)
    assert.equal(result.status, 'synced')
    assert.equal(args._calls.createCompany, 0) // reused existing company
    assert.equal(args._calls.createJob, 1)
  })

  test('a company creation failure marks the handoff failed and never attempts the job', async () => {
    const args = baseArgs({ deps: { createCompany: async () => { throw new Error('ServiceM8 API 500') } } })
    const result = await performServiceM8Handoff(args)
    assert.equal(result.status, 'failed')
    assert.match(result.error, /500/)
    assert.equal(args._calls.createJob, 0)
    assert.equal(args._handoffs['biz-1:job-1'].status, 'failed')
    assert.equal(args._handoffs['biz-1:job-1'].last_error, 'ServiceM8 API 500')
  })

  test('a response with no record uuid is treated as a failure, not a silent success', async () => {
    const args = baseArgs({ deps: { createCompany: async () => ({ recordUuid: null }) } })
    const result = await performServiceM8Handoff(args)
    assert.equal(result.status, 'failed')
    assert.match(result.error, /did not return a company uuid/)
  })

  test('a line-item sync failure is a warning, not a failed handoff — the job itself still synced', async () => {
    const args = baseArgs({ deps: { createJobMaterial: async () => { throw new Error('bad price') } } })
    const result = await performServiceM8Handoff(args)
    assert.equal(result.status, 'synced')
    assert.ok(result.warnings.some((w) => w.includes('bad price')))
  })

  test('a quote PDF attach failure is a warning, not a failed handoff', async () => {
    const args = baseArgs({ deps: { attachFile: async () => { throw new Error('upload timed out') } } })
    const result = await performServiceM8Handoff(args)
    assert.equal(result.status, 'synced')
    assert.ok(result.warnings.some((w) => w.includes('upload timed out')))
  })
})
