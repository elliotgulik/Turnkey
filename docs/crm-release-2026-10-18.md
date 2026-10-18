# CRM release — 18 October 2026

## Delivered

- The visual theme was reverted at the user’s request; existing styling and navigation icons are retained. Functional and workflow changes remain.
- Customers and independent Jobs / Invoices workspaces in primary navigation.
- Searchable customer selection for new jobs; existing lifecycle, document and payment actions reused.
- Native calendar appointments, busy blocks, crew booking and safe unscheduling. Imported Google events remain read-only; removing a local booking does not delete its Google event.
- Calendar and Stripe cards restored to Connections; pipeline stage management retained in Settings.
- New quotes launch Google Earth; saved quotes remain editable in TurnKey.
- 3D measurement placement tolerates minor camera jitter, waits for a stable scene and still rejects invalid surface picks.
- Public booking reads a restricted business profile rather than the internal business/pricing record.
- Database access tightened for integration tokens, backend-only tables, role changes and import undo. Privileged RPC implementations moved outside the exposed schema while retaining public signatures.

## Deployment and validation

Frontend and backend changes pushed to `main` in release `b0b36d6`. Production HTML was checked for the theme and new booking RPC before restricting public database access.

Applied migrations:

- `20261018100454_public_booking_profile.sql`
- `20261018100839_job_calendar_independent_events.sql`
- `20261018101447_crm_security_hardening.sql`

Validation was intentionally focused: assembled desktop/mobile app flow passed at 1440px and 390px, including the mounted Jobs / Invoices workspace and new-job form; nine targeted security/payment/module checks passed; static production build passed. Delegated calendar and 3D checks passed before integration. Database advisor was checked after the security migration.

No live customer jobs, invoices, payments or quote approvals were created for verification. Live Render rollout and real Google Earth surface-picking are not confirmed by the fixture checks.

## Remaining limits

- This release provides core independent workflows, not full feature parity with every ServiceM8 capability. A complete parity audit and broader real-world operational testing remain separate work.
- Security advisor now reports one warning only: leaked-password protection. The Supabase project is on Free; this feature requires Pro or above. No paid upgrade was made. See https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection.
- No claim of survey-grade satellite measurements: imagery resolution and Google's surface-pick availability still determine accuracy. Invalid geographic/elevation picks remain blocked.
- Existing invoice and payment helpers are reused; financial analytics continue to label unsupported totals as unavailable. A full accounting reconciliation across imported invoices, payments and quote versions has not been completed.
- Cursor's protected ServiceM8 integration modules were not modified.

The pre-existing untracked privacy draft and automatic draft-handoff migration were intentionally excluded from these commits.
