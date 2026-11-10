# Custom fixed-price service contract — 0.2.13

Extension and parent integration are implemented locally. No shared engine changes
or database migrations are required. Existing measured services and editable labels
retain their representation. Root `quote.html` supplements the legacy public RPC
with `GET /api/public/quotes/:token/services`, which returns only public service
fields and uses the accepted snapshot after approval. The backend and public page
changes belong to the same release. Nothing has been published.

## Saved `jobs.details.services[]` shape

```js
{
  svc: 'custom',
  pricingMode: 'fixed',
  lineKey: 'earth-0',
  label: 'Move outdoor furniture', // required, trimmed, 1–120 characters
  qty: 2,                        // positive number, defaults to 1
  unit: 'hour',                  // item (default), hour, day
  unitPrice: 115,                 // GST-inclusive customer dollars per unit
  fixedPrice: 230,                // round(qty * unitPrice, 2), TOTAL line amount
  customCost: null,               // optional TOTAL line delivery cost ex GST
  manual: true
}
```

An explicit `customCost: 0` is known zero. Missing/null cost is UNKNOWN.
`customCost` covers delivery for that entire item, not per unit. A custom-only
quote has no automatic measurement labour/travel/overhead allocation: enter its
full delivery cost to calculate margin. Mixed quotes retain the existing measured
cost estimate and add the entered custom line costs once. Unknown custom costs
produce `estimatedCost: null`, `estimatedMarginPct: null`, and snapshot
`costComplete: false`, `costUnrounded: null`, `cost: null`. `knownCost` is a partial
sum only; never use it to claim a complete margin. `costSnapshot.customLines[]`
contains `{lineKey, cost}` with null for unknown.

`quotes.amount` and `jobs.details.total` are the sum of saved service totals in
integer cents, including custom lines. The service metadata travels in the job's
existing `details` JSON; neither schema migrations nor new endpoints are needed.
Both `createJob` and `saveBoundQuote` already preserve it. `areaPolys` contains
measured lines only; custom-only quotes save `[]`.

## Parent consumer contracts (implemented locally)

- **Root CRM / PDF / invoice / customer handoff:** detect custom lines with
  `svc === 'custom' && pricingMode === 'fixed'`. Preserve the shape above through
  import, edit, confirm, sync, snapshot and reopen. Use `TK_PRICING.lineLabel(line)`
  (escaped at HTML insertion), `line.unit`, `line.qty`, and saved `fixedPrice`.
  Never require a registry entry or fabricate m², geometry or productivity.
  `index.html` has direct `SERVICES[line.svc].unit` / `.label` dereferences in
  review, service details, tags and summary paths; these must use a custom-aware
  descriptor. `confirmQuoteSend` must preserve metadata and nullable cost values.
- **Totals:** existing public `TK_PRICING.lineTotal` already reads `fixedPrice`
  before service lookup. Its `quoteTotal` still applies access to ALL lines and
  rounds to whole dollars. Do not use it to reprice a saved custom quote. Keep
  the persisted quote amount / exact cent sum, and exclude custom prices from
  any access premium or whole-dollar recomputation. Measured pricing stays as is.
- **Public quote:** `quote.html` functions `pubPropertySummary` and
  `pubPriceBreakdown` currently return empty strings for unknown service keys.
  Render custom descriptors instead. Customer total/GST should use saved amount.
  Never expose `customCost`, cost snapshots, estimated costs or margins in public
  payloads. Whitelist public fields: svc, pricingMode, label, qty, unit,
  unitPrice, fixedPrice (and priceSnapshot if used by the existing lifecycle).
- **Immutable/public versions:** `backend/src/salesPlatform.js` has explicit
  service-field lists in `contentFingerprint` and `publicVersion`; add
  `pricingMode`, `unit`, `unitPrice`, and ensure `fixedPrice` survives public
  versions. Cost fields must remain internal. Audit canonical snapshot/sync
  consumers for equivalent field lists before customer delivery.
- **ServiceM8:** `backend/src/salesTransfer.js` `approvedLines` already falls back
  to saved `fixedPrice` and `label`, so custom items transfer with exact allocated
  amounts. It currently appends `(<qty> units)`; use the saved custom unit for
  custom rows. Keep its existing GST conversion and amount reconciliation.
- **Cost consumers:** shared `TK_COST.costBreakdown` ignores unregistered custom
  services. Preserve extension cost snapshots or explicitly merge the entered
  total line costs while propagating unknowns; do not recompute complete margins
  from measured lines alone. No changes were made to shared engines in this task.
- **Learning:** custom lines are omitted from recommendation inputs and
  `quoteLearning.lines`. A custom-only quote skips the learning POST entirely.
  Parent calibration consumers must also exclude custom lines.

## Package

`node extension/scripts/pack.cjs` refreshes unchanged vendor engines and writes
`extension/dist/turnkey-earth-extension-0.2.13.zip`. Parent owns copying the ZIP
into downloadable site assets and any root download version/link changes.
