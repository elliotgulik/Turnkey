# Earth quote learning integration (extension 0.2.9)

The extension owns its UI, authenticated proxy actions and packaging. Root CRM assets, backend and migrations are owned by main. No CRM context script changes are required: existing business/customer/job binding remains in use.

## Runtime and authenticated API

`app.js` imports the packaged UMD engine from `vendor/pricing-learning-engine.js`; the browser global is `globalThis.TK_PRICE_LEARNING` (also `window.TK_PRICE_LEARNING`). A missing/failed engine or state endpoint falls back to base recommendations with fully editable service prices and a visible explanation.

On every quote-panel open, the extension fetches fresh state using `TurnKeyApi.getPricingLearningState(businessId)` → named `TK_API` action → background `TurnKeyClient` → authenticated `GET /api/pricing-learning/state`. The result must contain `{settings, observations, modelVersion:1}`. No learning state is persisted in extension storage or sent to public pages. Business/identity/deployment changes close the dialog; generation guards discard in-flight old responses, including switching away and back. The backend proxy requires real profile membership and the existing optional backend host permission. The popup enables backend access for both learning and ServiceM8.

Recommendations call `recommend({businessId, lines, observations, settings, context:{gstRegistered}})`. Each line supplies `{lineKey,svc,unit,quantity,baselinePrice,marginFloor,storeys,access}`. Base is the larger of configured service pricing with access multiplier and the cost engine's allocated target-margin recommendation. The floor allocations include shared job costs and use the current target margin. Dollar adjustments, distinct-quote sample counts, confidence and explanations appear per line. Learned recommendations stay above the floor; final manual prices can be lower with an explicit warning. Engine quantity/context matching remains authoritative.

## Saved snapshot and observation submission

Every included service is saved, in the same order, as `job.details.services`. Its `fixedPrice` is the displayed final customer dollar amount; integer cents sum exactly to `job.details.total`. `job.details.quoteLearning` is included **before** durable save:

```js
{
  quoteKey, // UUID stable throughout this quote-panel save intent and retries
  lines: [{
    lineKey, svc, unit, quantity, baselinePrice, chosenPrice,
    reason, storeys, access,
    // Present only after explicit quantity verification + Apply:
    measuredQuantity, verifiedQuantity, measurementReason
  }],
  context: {
    source: 'earth-extension', modelVersion: 1,
    estimatedCost, estimatedDurationMin, travelKm, targetMargin, gstRegistered,
    originalQuantities: { [lineKey]: rawQuantity }
  }
}
```

`quantity` always equals the saved service's `qty`, including an explicitly applied correction. `measuredQuantity` and `originalQuantities` retain the original raw quantity. `verifiedQuantity` is the corrected saved quantity. Applying changes a service's billable quantity, never its polygon/geometry; raw `areaPolys` remain intact. A learned measurement hint first populates the verification input; the operator chooses a measurement reason and clicks **Apply verified quantity** before any quantity changes.

Reasons are `pricing_correction`, `difficult_access`, `extra_work`, `discount`, `measurement_correction`, or blank. Blank remains blank in the authoritative snapshot/POST and backend normalizes it to excluded `unexplained`. The extension deliberately requires an explicit price-training reason, including for unchanged base prices. Pricing corrections and matching difficult-access samples can train prices; discounts never do. Measurement reasons use the backend enum: `verified_measurement`, `manual_measurement`, `site_measurement`, `measurement_correction`. Explicit verified measurement evidence is separate from price learning.

After `createQuoteDraft()` returns durably saved, business-verified quote/job rows, the extension submits **all** lines via `POST /api/pricing-learning/observations` with `{quoteKey, jobId: actualSavedJob.id, lines, context}`. `job.quote_id` must equal the returned quote ID. Saved context and POST context are the same snapshot; the backend sanitizes supported fields. No excluded lines are omitted, since saved service quantities, line counts and totals must reconcile.

Observation failure is nonfatal: the saved-quote screen shows a warning and **Retry saving learning**. Retries reuse the identical body, saved job ID, quote key and line keys; concurrent clicks coalesce. Backend `UNIQUE(business_id,quote_key,line_key)` provides deduplication after ambiguous/lost responses. The extension does not create another quote during a learning retry. Account changes invalidate that retry. If the screen is closed before retry, the authoritative snapshot remains on the saved job, but the extension retry button belongs to that open success screen.

## Editing and totals

Each row owns its manual price across ordinary rerenders, access/levels/margin/travel changes, service inclusion toggles and fresh recommendation calculations. A reused outline creates a new independently editable row. Changing service preserves its entered dollar price but clears quantity verification and explanation for the previous service.

The legacy total input is an uncommitted value until **Distribute entered total across services** is clicked. Distribution explicitly replaces line prices using largest-remainder integer-cent allocation and clears price-training explanations. **Discard entered total** keeps line prices; service/all-service reset buttons explicitly restore recommendations. Saving with a pending total asks the operator to distribute or discard it. No silent total override is applied.

## Package and checks

```sh
node extension/scripts/pack.cjs
node --test extension/tests/*.test.cjs extension/tests/*.test.mjs
```

The pack script recopies all three finished root engines byte-for-byte into `extension/vendor/`, then uses standard `zip` to create `extension/dist/turnkey-earth-extension-0.2.9.zip`. The archive contains `manifest.json` at its root, with runtime files, icons and README; tests and packaging scripts are excluded. Main publishes that file to `assets/turnkey-earth-extension-0.2.9.zip` and updates the root download URLs. Re-run the pack command whenever a shared engine changes.

Focused tests cover cent allocation, cost target floors, edits surviving recalculation, the real engine ignoring discounts/unexplained price samples, optional-engine fallback, durable snapshot ordering and duplicate-safe observation retries, authenticated business checks, and a local Playwright fixture using the real finished engine. Browser checks also exercise explicit quantity/hint application, raw quantity preservation, total distribution, exact saved itemisation and the visible retry warning. No live CRM/network calls are required by the fixtures.

Optional learning requests have total deadlines, including membership lookup: 1500 ms for opening history and 2500 ms for post-save submission. Timeouts abort backend fetches, fall back visibly and never turn durable quote saving into a failed quote. Late membership lookups check the aborted signal before issuing a backend request.

Service price input/change events update row state, item totals, tax, profit, margin and floor warnings in place. They do not repaint the dialog or replace the input/Create button on blur. The browser regression fills a service price then clicks Create exactly once, asserting the saved amount and stable DOM elements.
