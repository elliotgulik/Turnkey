// Idempotent quote/job creation, pulled out of app.js so it can be unit
// tested without a DOM/chrome runtime (see extension/tests/quote-create.test.cjs).
// `progress` is a plain object the caller persists across retries of the
// SAME quote-panel session (app.js resets it to `{}` only when a brand new
// quote-panel is opened, or after a success here) — each step only runs
// once per intent, so retrying after a failed step reuses the ids already
// created instead of creating duplicate customers/quotes/jobs.
export async function createQuoteDraft(api, progress, { businessId, payload, screenshotDataUrl }) {
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

  let quote = progress.quote;
  if (!quote) {
    quote = await api.createQuote(businessId, { id: progress.ids.quote, customerId, amount: payload.total });
    progress.quote = quote;
  }

  let job = progress.job;
  if (!job) {
    job = await api.createJob(businessId, {
      id: progress.ids.job,
      customerId,
      quoteId: quote.id,
      details: {
        address: payload.address || '',
        services: payload.lines,
        total: payload.total,
        areaPolys: payload.areaPolys,
        source: 'Google Earth Extension'
        // No `quoteSentAt` — this creates a DRAFT (see turnkey-api.js's
        // createQuote status: 'draft'); nothing has actually been sent to
        // the customer yet, so the CRM's own follow-up timers must not
        // start as if it had been.
      }
    });
    progress.job = job;
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
    await api.logActivity(businessId, {
      customerId,
      jobId: job.id,
      type: 'note',
      summary: 'Quote drafted from Google Earth — ' + payload.lines.length + ' service' + (payload.lines.length === 1 ? '' : 's') + ', ' + payload.total
    });
    progress.activityLogged = true;
  }

  return { customerId, quote, job };
}
