// Tests createQuoteDraft() (extension/content/panel/quote-create.js) for
// write-allocation correctness: exactly one customer/quote/job per quote
// intent, even when an earlier attempt fails partway through and is
// retried with the same `progress` object — the scenario the extension
// README flags as "resolve partial write failures and retries without
// duplicating a quote".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

async function loadModule() {
  return import(path.join(__dirname, '..', 'content', 'panel', 'quote-create.js'));
}

function makeApi(overrides = {}) {
  let customerSeq = 0, quoteSeq = 0, jobSeq = 0;
  const calls = { createCustomer: [], createQuote: [], createJob: [], logActivity: [], uploadScreenshotDataUrl: [] };
  return {
    calls,
    createCustomer: async (businessId, payload) => {
      calls.createCustomer.push({ businessId, payload });
      if (overrides.createCustomer) return overrides.createCustomer(businessId, payload);
      return { id: 'cust_' + ++customerSeq };
    },
    createQuote: async (businessId, payload) => {
      calls.createQuote.push({ businessId, payload });
      if (overrides.createQuote) return overrides.createQuote(businessId, payload);
      return { id: 'quote_' + ++quoteSeq, public_token: 'tok_' + quoteSeq, business_id: businessId };
    },
    createJob: async (businessId, payload) => {
      calls.createJob.push({ businessId, payload });
      if (overrides.createJob) return overrides.createJob(businessId, payload);
      return { id: 'job_' + ++jobSeq, business_id: businessId };
    },
    logActivity: async (businessId, payload) => {
      calls.logActivity.push({ businessId, payload });
      if (overrides.logActivity) return overrides.logActivity(businessId, payload);
      return {};
    },
    uploadScreenshotDataUrl: async (...args) => {
      calls.uploadScreenshotDataUrl.push(args);
      if (overrides.uploadScreenshotDataUrl) return overrides.uploadScreenshotDataUrl(...args);
      return {};
    }
  };
}

const samplePayload = {
  isNewCustomer: true,
  customer: { name: 'Jane Doe', phone: '0211234567', email: 'jane@example.com' },
  address: '42 Example St',
  lines: [{ svc: 'roof', qty: 80 }],
  total: 450,
  areaPolys: [{ id: 'a1' }]
};

test('a failed activity note cannot turn a saved quote into a failed quote',async()=>{
 const {createQuoteDraft}=await loadModule();
 const api=makeApi({logActivity:async()=>{throw new Error('activity unavailable');}});
 const result=await createQuoteDraft(api,{}, {businessId:'B',payload:samplePayload});
 assert.ok(result.quote.id);assert.ok(result.job.id);
 assert.match(result.warning,/quote is saved/i);
 assert.equal(api.calls.createQuote.length,1);
 assert.equal(api.calls.createJob.length,1);
});

test('creates exactly one customer, quote, and job for a single successful run', async () => {
  const { createQuoteDraft } = await loadModule();
  const api = makeApi();
  const progress = {};
  const result = await createQuoteDraft(api, progress, { businessId: 'biz1', payload: samplePayload, screenshotDataUrl: null });
  assert.equal(api.calls.createCustomer.length, 1);
  assert.equal(api.calls.createQuote.length, 1);
  assert.equal(api.calls.createJob.length, 1);
  assert.equal(api.calls.logActivity.length, 1);
  assert.equal(result.customerId, 'cust_1');
  assert.equal(result.quote.id, 'quote_1');
  assert.equal(result.job.id, 'job_1');
});

test('quotes are created as drafts, never a fake-sent/approved status, and carry no fake sent timestamp', async () => {
  const { createQuoteDraft } = await loadModule();
  const api = makeApi();
  await createQuoteDraft(api, {}, { businessId: 'biz1', payload: samplePayload, screenshotDataUrl: null });
  // createQuoteDraft itself doesn't set `status` (that's turnkey-api.js's
  // createQuote(), hardcoded to 'draft') — what this module controls is
  // the job details payload, which must never claim a send happened.
  const jobDetails = api.calls.createJob[0].payload.details;
  assert.equal('quoteSentAt' in jobDetails, false);
});

test('retrying after createJob fails reuses the already-created customer and quote, never duplicating them', async () => {
  const { createQuoteDraft } = await loadModule();
  let jobAttempt = 0;
  const api = makeApi({
    createJob: async () => {
      jobAttempt++;
      if (jobAttempt === 1) throw new Error('network blip');
      return { id: 'job_retry_ok' };
    }
  });
  const progress = {};

  await assert.rejects(() => createQuoteDraft(api, progress, { businessId: 'biz1', payload: samplePayload, screenshotDataUrl: null }), /network blip/);
  assert.equal(api.calls.createCustomer.length, 1);
  assert.equal(api.calls.createQuote.length, 1);
  assert.equal(api.calls.createJob.length, 1);

  const result = await createQuoteDraft(api, progress, { businessId: 'biz1', payload: samplePayload, screenshotDataUrl: null });
  // Second attempt: customer/quote NOT recreated — only the job (the step
  // that actually failed) is retried.
  assert.equal(api.calls.createCustomer.length, 1);
  assert.equal(api.calls.createQuote.length, 1);
  assert.equal(api.calls.createJob.length, 2);
  assert.equal(result.customerId, 'cust_1');
  assert.equal(result.quote.id, 'quote_1');
  assert.equal(result.job.id, 'job_retry_ok');
});

test('retrying after everything already succeeded (progress fully populated) makes no further writes at all', async () => {
  const { createQuoteDraft } = await loadModule();
  const api = makeApi();
  const progress = {};
  await createQuoteDraft(api, progress, { businessId: 'biz1', payload: samplePayload, screenshotDataUrl: null });
  await createQuoteDraft(api, progress, { businessId: 'biz1', payload: samplePayload, screenshotDataUrl: null });
  assert.equal(api.calls.createCustomer.length, 1);
  assert.equal(api.calls.createQuote.length, 1);
  assert.equal(api.calls.createJob.length, 1);
  assert.equal(api.calls.logActivity.length, 1);
});

test('progress is business-bound: reusing the same progress object for a different business never adopts the old ids', async () => {
  const { createQuoteDraft } = await loadModule();
  const api = makeApi();
  const progress = {};
  const first = await createQuoteDraft(api, progress, { businessId: 'biz1', payload: samplePayload, screenshotDataUrl: null });
  assert.equal(first.quote.business_id, 'biz1');

  // Same `progress` object, but now for a different business — e.g. the
  // operator disconnected and reconnected a different TurnKey account
  // while the quote panel stayed open.
  const second = await createQuoteDraft(api, progress, { businessId: 'biz2', payload: samplePayload, screenshotDataUrl: null });
  assert.equal(second.quote.business_id, 'biz2');
  assert.notEqual(second.quote.id, first.quote.id);
  assert.notEqual(second.customerId, first.customerId);
  assert.equal(api.calls.createCustomer.length, 2);
  assert.equal(api.calls.createQuote.length, 2);
  assert.equal(api.calls.createJob.length, 2);
});

test('a progress object holding an id for the wrong business (corrupted/foreign state) is never adopted, even without a businessId mismatch trigger', async () => {
  const { createQuoteDraft } = await loadModule();
  const api = makeApi();
  // Simulates a progress object that already has `businessId` set to the
  // current business, but whose `quote`/`job` records (however that
  // happened — e.g. resurrected from a corrupted persisted state) belong
  // to a different one.
  const progress = { businessId: 'biz1', quote: { id: 'quote_other_biz', business_id: 'some-other-biz' } };
  const result = await createQuoteDraft(api, progress, { businessId: 'biz1', payload: samplePayload, screenshotDataUrl: null });
  assert.equal(result.quote.business_id, 'biz1');
  assert.notEqual(result.quote.id, 'quote_other_biz');
  assert.equal(api.calls.createQuote.length, 1);
});

test('an existing customer (not isNewCustomer) is never (re)created', async () => {
  const { createQuoteDraft } = await loadModule();
  const api = makeApi();
  const payload = { ...samplePayload, isNewCustomer: false, customer: { id: 'existing_cust_9' } };
  const result = await createQuoteDraft(api, {}, { businessId: 'biz1', payload, screenshotDataUrl: null });
  assert.equal(api.calls.createCustomer.length, 0);
  assert.equal(result.customerId, 'existing_cust_9');
});

test('a failed screenshot upload does not block quote/job creation or get silently retried as a duplicate quote', async () => {
  const { createQuoteDraft } = await loadModule();
  const api = makeApi({ uploadScreenshotDataUrl: async () => { throw new Error('upload failed'); } });
  const result = await createQuoteDraft(api, {}, { businessId: 'biz1', payload: samplePayload, screenshotDataUrl: 'data:image/png;base64,AAAA' });
  assert.equal(api.calls.createQuote.length, 1);
  assert.equal(api.calls.createJob.length, 1);
  assert.ok(result.job.id);
});
