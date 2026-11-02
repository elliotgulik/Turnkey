# Customer recovery and mobile release — 3 November 2026 NZ

## Included

- Wix parsing matches the live automation's `data.submissions[{label,value}]`
  envelope. Names, contact fields, structured addresses, multiple services,
  window type, urgency and other labelled form answers are retained. Stable
  submission IDs continue through existing tenant-scoped duplicate protection.
- Customer table identity wins over blank/stale job-detail snapshots during
  hydration. ServiceM8 profile refresh fills only missing contact fields, with
  optimistic conditions preserving concurrent edits.
- Archived testing jobs and intake are excluded from the workspace and sales
  metrics. They remain recoverable in storage rather than being deleted.
- Responsive lead cards, wrapping controls, readable form answers, compact
  category-based Settings, and a resumable new-owner setup checklist.
- Calendar range-cache reuse and bounded range loading; inbox messages display
  without waiting for drafts; duplicate draft saves share requests; mail timeout
  gives a visible result. Cached quote PDFs bypass repeated map preloading.
- Connections open existing cards immediately, coalesce pending checks and cache
  recent status per authenticated session. Background checks preserve typed
  credentials.

## Already executed against the live database

The two evidence-based recovery passes restored 202 missing names and 491 other
missing contact fields (693 fields total). Existing populated values, stages,
prices and quote history were preserved. 19 linked jobs still lack a trustworthy
saved identity; no identity was invented. Detailed evidence and queries are in
`identity-recovery-handoff-20261102.md`.

29 matching testing jobs and 11 matching intake submissions were soft archived
using the user's Elliot / 30 Eversleigh criteria. The workspace filters become
visible after this frontend is deployed. The migration
`20261102113209_preserve_testing_lead_archive.sql` was already applied live to
preserve archive flags against stale client writes. No repeat application is
needed for that environment.

The previously approved ServiceM8 full import completed successfully. This does
not constitute a full accounting reconciliation.

## Wix inspection

The active NZ Nova Exterior Old Wix Forms automation already posts **All
automation data**, nested under `data`, to the existing TurnKey Wix endpoint.
Its request preview exposes labelled submission values and submission IDs.
No automation or credentials were changed, and no synthetic lead was submitted.
A fresh real submission through the deployed parser remains the final live
delivery check. See `wix-form-field-contract.md` for supported shapes and limits.

## Focused verification

- 52 Wix handler/parser tests passed using fixtures.
- 10 customer hydration/recovery checks passed.
- 24 selected ServiceM8 import/missing-data/tenant tests passed.
- Calendar and Conversations browser regressions passed with intercepted traffic.
- Settings/Conversations usability check passed, including retained embeds,
  integrations and unsaved form edits.
- Quote compose/PDF bridge browser regression passed; no actual email sent.
- Two desktop/mobile visual passes found no page or visible-button overflow at
  390px/360px on the six reviewed workspace screens.
- Static build, changed-script syntax and whitespace checks passed.

## Release boundaries

This code release is prepared locally for visual approval before pushing.
Automatic customer follow-ups remain disabled. No credentials were changed.
Render's existing free-instance cold starts and Gmail/provider latency remain
external limits; this release does not promise zero network delay. It does not
add a new CRM framework or replace public booking/quote pages.
