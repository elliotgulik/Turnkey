# Sales platform architecture and metric definitions

TurnKey owns enquiries, sales records, original quotes, attribution and estimated profitability. ServiceM8 owns scheduling, job delivery, invoices and payments. Existing customers/jobs/quotes remain the storage model; no records or tables are removed.

## Reused and archived

The existing map editor, pricing engine, internal cost engine, document/email engine, public booking form, quote approval page, Supabase Auth, tenant scoping, Gmail, Wix/Meta intake and Import Wizard are reused. Pricing and cost code stay separate: public pages do not load internal cost calculations.

The pre-change application is recoverable from `archive/pre-sales-platform-overhaul-20261015` and `archive/pre-sales-platform-overhaul/application.tar`. Operational views are removed from primary navigation and inaccessible through the sales navigation dispatcher. Shared legacy functions remain in index.html because quoting, customer lookup and document generation depend on them. This is an incremental migration, not deletion of all operational code.

## Metrics

`sales-metrics.js` provides the same definitions to the browser and authenticated backend. A selected range includes its start and excludes its end. Calendar selections use local calendar boundaries; the browser sends absolute boundaries to the backend. Previous period has the same duration immediately before the selected range.

- Leads: enquiries whose original submission/creation date falls in the range.
- New leads: those leads still at New Lead.
- Quotes sent/value/average quote: records whose first recorded quote-send date falls in the range, using their saved quote total. This is opportunity-level reporting, not a count of every resent version.
- Booked sales/average sale: currently won opportunities whose recorded won/approval date falls in the range. Legacy scheduled/completed/paid records count as won, but undated historical wins are excluded from dated revenue and disclosed as unknown history.
- Lead conversion: current won records divided by leads in the arrival cohort. Later outcomes update that cohort.
- Quote acceptance: currently won quoted opportunities divided by quoted opportunities in that arrival cohort. Manual wins are included; this is not exclusively online approvals.
- First response and days to close: average elapsed time only where both original arrival and reliable event timestamps exist.
- Estimated gross profit/margin: known saved job cost subtracted from ex-GST booked revenue. GST-registered records use the existing NZ 15% GST convention. Missing historical GST/cost information is excluded and coverage is displayed. Actual profit is not asserted.
- Source/salesperson attribution: arrival-cohort leads and their currently won value. Source revenue may differ from booked-sales event revenue for the same range.
- Cost per lead/acquisition: dated, manually recorded source spend divided by cohort leads/wins. Missing spend is unavailable, not zero. ROAS is attributed cohort won value divided by known positive spend; it is not independently verified ad-platform attribution.
- Service revenue: booked total allocated across saved line-price snapshots; missing line prices are unavailable. Quoted cost remains an estimate.
- Current pipeline/forecast: open opportunities across all dates, explicitly shown separately from period activity. Forecast applies configured stage probabilities or the selected cohort's historical win ratio. It is probabilistic and is not booked revenue.
- Invoiced/collected revenue: available only from linked ServiceM8 snapshots with complete coverage of period wins. Missing permissions or unlinked jobs result in unavailable figures.
- Goals: dated targets evaluated with the same formulas; salesperson scope filters the underlying records. Revenue pace uses booked sales, with weighted pipeline shown separately. Business-tagged local goals remain visible as legacy goals. Earlier unscoped device caches are archived separately and never auto-assigned to an account; the Goals recovery action requires the user to confirm ownership before recovering only those goals.

## Durability and ownership

Public lead webhooks write to the existing intake table. Browser ingestion must save the customer/job before acknowledging intake. Provider/source/external references are retained. Database uniqueness protects webhook retries; transient client claim leases do not replace provider deduplication.

Quote approvals are idempotent in Postgres. Accepted amounts, quote references and commercial job details are locked; append-only quote versions preserve customer/branding/line snapshots. Additional work needs a new opportunity. Historical quotes are not recalculated from current rates.

ServiceM8 secrets are encrypted server-side in the canonical connection table. OAuth state is single-use, business/user scoped and bound to a browser cookie. Connection changes require owner/manager access. Durable tasks use unique business/kind keys, atomic claims, expiring leases, fencing tokens and bounded retries. Mappings reserve deterministic UUIDs before remote creation; retry paths check the remote object before recreating it. Accepted quote PDF and line-item transfer failures remain retryable rather than falsely completing a transfer.

ServiceM8 webhooks use a per-business hashed callback token and acknowledge only after durable queue insertion. The worker fetches changed resources with that business's credentials. Operational status is kept in external snapshots rather than overwriting TurnKey's sales stage. The protected Cursor implementation is preserved byte-for-byte; the frontend uses the hardened `/api/sales/servicem8` adapter. Legacy connection API paths are retired with HTTP 410; the canonical tokened webhook is handled before that block.

Sales reminders notify the business only. Customer email remains a deliberate action; the old automatic follow-up sender is disabled in the sales interface.

## Validation boundaries

Automated database, metric, backend and responsive browser tests use synthetic data. These are not evidence of a real ServiceM8 account transfer, a Meta lead delivery, Gmail refresh success or provider approval. Those checks require the relevant connected accounts and consent. See CONNECTIONS_SETUP.md and DEPLOYMENT_REPORT.md for actual rollout evidence and outstanding requirements.
