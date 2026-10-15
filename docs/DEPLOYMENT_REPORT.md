# Sales platform release report

Release date: 15 October 2026. This file is updated with observed deployment results; missing provider credentials are not treated as successful connections.

## Recovery and scope

Recovery tag: `archive/pre-sales-platform-overhaul-20261015`, baseline `58095e83ce7862ffc839608ce4b7b640ebef3b0e`.
Recovery archive: `archive/pre-sales-platform-overhaul/application.tar` (tracked source only, no ignored credentials).

The release keeps the plain HTML/JavaScript architecture. Seven primary sections replace operational navigation. Dashboard, Analytics, Goals, sales record details and pipeline use the new sales shell; maps, pricing/cost engines, documents, public booking, public quotes, Gmail, intake and imports reuse existing infrastructure. Underlying customer/job data remains intact.

Cursor's seven ServiceM8 implementation/schema/test files are preserved exactly from `servicem8-integration` (`3491469b8e82c9e4cbea86d3029f98313c403cf3`), including its shared index import and router block. New integration orchestration is additive. Legacy connection routes are intentionally retired in favor of the safer sales adapter; the tokened webhook is handled first.

## Database rollout

Target: existing Supabase project `rcighpmdrutnghsqhzlr` (TurnKey CRM).

Required schema, in order:

1. `backend/supabase/schema-servicem8.sql` — canonical connection, mapping, handoff and webhook tables; unchanged from Cursor.
2. `supabase/migrations/20261015061746_sales_platform.sql` — sales configuration/goals/spend/events, immutable quote versions, canonical connection extensions, external mappings, durable integration tasks and OAuth state; explicit RLS and grants; safe public quote RPCs and event timestamps.

3. `supabase/migrations/20261015071000_secure_lead_sources.sql` — corrects the existing Wix/Meta source table's missing RLS/grants and enforces one source per provider per business.

The first two scripts were applied successfully together in one migration transaction during this rollout, so canonical secret tables are never exposed between creation and RLS/grants. The lead-source restriction migration was then applied successfully after a zero-duplicate preflight and isolated permission/uniqueness test. No customer/job table is dropped or truncated, and existing credentials are not replaced. SQL tests run against an isolated PostgreSQL-compatible PGlite database before rollout. Live preflight found zero unmatched customer/quote links, zero cross-business or mismatched quote/customer links, and zero shared quote references.

## Hosting configuration verified

- Netlify site `turnkeycrm` publishes https://turnkeycrm.net from main with automatic publishing enabled. Repository build prepares a browser-only `.netlify-dist`; backend, archives, tests and migrations are excluded.
- Render service `Turnkeynova` (`srv-d9c3c9vavr4c73a8fp90`) publishes https://turnkeynova.onrender.com from main; root backend, build npm install, start npm start; Auto-Deploy enabled.
- Render URL settings saved for next deploy: PUBLIC_BACKEND_URL=https://turnkeynova.onrender.com and FRONTEND_URL=https://turnkeycrm.net. Existing encrypted-token key, Gmail and Supabase secrets preserved.

## Verification

Live schema application succeeded. Post-migration checks confirm all new sales/integration tables have RLS enabled; credential, mapping, task and OAuth-state tables deny anonymous and authenticated browser reads. The follow-up advisor exposed the pre-existing lead_sources omission, now corrected. All 103 automated tests pass (43 frontend/metric/database tests and 60 backend tests). Responsive browser checks pass at 1440px and 390px, covering lead search/stage changes, native desktop drag, details, goals recovery, quote editor, public booking/quote page loading, and page overflow. Synthetic browser screenshots are kept locally under .artifacts. Static publishing build passes. Hosting rollout verification follows below.

The advisor also flags intentional public quote RPCs and backend-only tables with no policies (deny by default), plus pre-existing mutable search_path and password-protection notices outside this release. See [Supabase advisor definitions](https://supabase.com/docs/guides/database/database-linter) and [password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). No blanket security-clearance claim is made.

## Provider state and remaining external requirements

The signed-in TurnKey business reports Gmail and Wix as connected. Status alone does not prove a fresh token refresh or successful provider delivery. Existing Wix URL was not regenerated.

Render has no ServiceM8 client credentials or Meta application secret/verification token. ServiceM8 OAuth requires a registered developer application and the account owner's scoped authorization. Private API-key testing can be used for one company once its key is entered securely. Meta requires an app, Page lead access, a usable Page token, leadgen subscriptions, and any required app review. These are account/provider prerequisites; the application cannot invent or bypass them.

No customer email, advertising spend, remote customer/job or payment was created to test this release. Live provider end-to-end verification remains distinct from mocked tests. Actual profit is unavailable without actual job-cost data. ServiceM8 financial figures show incomplete coverage explicitly. See CONNECTIONS_SETUP.md for exact connection steps and SALES_PLATFORM.md for metric definitions.
