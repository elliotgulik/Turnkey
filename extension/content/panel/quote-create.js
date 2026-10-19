// Idempotent quote/job creation, pulled out of app.js so it can be unit
// tested without a DOM/chrome runtime (see extension/tests/quote-create.test.cjs).
// `progress` is a plain object the caller persists across retries of the
// SAME quote-panel session (app.js resets it to `{}` only when a brand new
// quote-panel is opened, or after a success here) — each step only runs
// once per intent, so retrying after a failed step reuses the ids already
// created instead of creating duplicate customers/quotes/jobs.
export async function createQuoteDraft(api, progress, { businessId, payload, binding = null, screenshotDataUrl }) {
  if (binding && (binding.businessId !== businessId || payload.isNewCustomer || payload.customer.id !== binding.customerId)) throw new Error('This draft must stay linked to its original business and customer.');
  if (binding?.recordId != null && !binding.jobId) throw new Error('Reopen this opportunity from an updated TurnKey CRM with its saved job ID.');
  if (progress.binding && JSON.stringify(progress.binding) !== JSON.stringify(binding)) throw new Error('This draft must stay linked to its original opportunity.');
  if (binding) progress.binding = {...binding};
  // Business-bound intent: if the signed-in business changed since an
  // earlier attempt with this SAME progress object (e.g. the operator
  // disconnected and reconnected a different TurnKey account while the
  // quote panel was still open), any ids it's holding belong to a
  // different business and must never be reused for this one.
  if (progress.businessId && progress.businessId !== businessId) {
    for (const key of Object.keys(progress)) delete progress[key];
  }
  progress.businessId = businessId;
  const fingerprint=JSON.stringify(payload);
  if (progress.fingerprint && progress.fingerprint !== fingerprint) throw new Error('This draft is partly saved. Restore its original customer and services before retrying, or reopen the quote builder to start a separate draft.');
  progress.fingerprint=fingerprint;
  progress.ids ||= { customer: crypto.randomUUID(), quote: crypto.randomUUID(), job: crypto.randomUUID() };

  // Ownership check before adopting a previously "succeeded" step: a
  // stale/corrupted progress object (or one resurrected from storage after
  // an unexpected restart) is verified against the row it actually
  // created before being trusted, rather than assumed correct just because
  // a local field is set.
  if (progress.quote && progress.quote.business_id !== businessId) delete progress.quote;
  if (progress.job && progress.job.business_id !== businessId) delete progress.job;

  let customerId = payload.isNewCustomer ? progress.customerId : payload.customer.id;
  if (payload.isNewCustomer && !customerId) {
    const created = await api.createCustomer(businessId, {
      id: progress.ids.customer,
      name: payload.customer.name,
      phone: payload.customer.phone || '',
      email: payload.customer.email || '',
      address: payload.address || '',
      source: 'Google Earth Extension'
    });
    customerId = created.id;
    progress.customerId = customerId;
  }

  const details = {
    address:payload.address || '', services:payload.lines, total:payload.total, areaPolys:payload.areaPolys,
    ...(payload.costSnapshot ? {costSnapshot:payload.costSnapshot,estimatedCost:payload.estimatedCost,estimatedMarginPct:payload.estimatedMarginPct,gstRegistered:payload.gstRegistered,targetMargin:payload.targetMargin} : {})
  };
  let quote = progress.quote, job = progress.job;
  if (binding?.jobId) {
    if (!job) {
      ({quote,job} = await api.saveBoundQuote(businessId, {binding,quoteId:progress.ids.quote,total:payload.total,details}));
      progress.quote = quote;
      progress.job = job;
    }
  } else {
    if (!quote) {
      quote = await api.createQuote(businessId, {id:progress.ids.quote,customerId,amount:payload.total});
      progress.quote = quote;
    }
    if (!job) {
      job = await api.createJob(businessId, {id:progress.ids.job,customerId,quoteId:quote.id,details:{...details,source:'Google Earth Extension'}});
      progress.job = job;
    }
  }

  if (screenshotDataUrl && !progress.screenshotUploaded) {
    try {
      await api.uploadScreenshotDataUrl(businessId, customerId, job.id, screenshotDataUrl);
      progress.screenshotUploaded = true;
    } catch {
      // Non-fatal — the quote itself already succeeded.
    }
  }

  if (!progress.activityLogged) {
    try {
      await api.logActivity(businessId, {
      customerId,
      jobId: job.id,
      type: 'note',
      summary: 'Quote drafted from Google Earth — ' + payload.lines.length + ' service' + (payload.lines.length === 1 ? '' : 's') + ', ' + payload.total
      });
      progress.activityLogged = true;
      delete progress.activityWarning;
    } catch {
      progress.activityWarning='Your quote is saved. Its activity note could not be recorded.';
    }
  }

  return { customerId, quote, job, warning:progress.activityWarning || '' };
}
