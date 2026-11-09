# The Post Office production workspace

Owner: jackie@thepostoffice.co.nz. Release is restricted to this existing company and its invited members. It does not provision, invite, reassign or merge any account.

Preview: http://127.0.0.1:8881/post-office.html?demo=1 . Demo mode is enabled only on loopback hosts, uses sessionStorage in the preview tab, and never reads or writes company records. Do not treat preview imports as live imports. Export a workspace backup before closing the preview tab if you want to retain it.

Production route is post-office.html. It uses existing Supabase sign-in and verifies membership of company 83c8112c-ad39-468d-b384-de593767e291. Managers edit company-wide data; other members complete SOP tasks and log their own mapped crew hours through narrow RPCs. Other TurnKey accounts retain their existing application. Members of this company are routed to the production workspace after sign-in. index.html?standard=1 retains access to the standard app. Database RLS also scopes every row to the current business and requires current authenticated membership of the pinned company. The separate workspace stores no exterior-cleaning settings and changes none of the shared pricing engines.

Implemented: month/week/day/agenda calendar, all-project/per-project and production-phase filters; editable bookings and milestones; weekly-grid and standard CSV preview/import with duplicates skipped; projects with client/agency/contact, brief, deliverables and current phase; crew by role/name/contact/booking status; per-project checklists with category-specific reusable editable templates; custom category names/colours; editable itemised production quotes with quantity/unit/sell rate/internal cost, ex-GST subtotal, configurable GST, cost/margin and clean printable customer PDF preview. Rates are deliberately not supplied as actual business pricing is unknown. Quote PDF export uses browser Print / Save PDF. It does not send emails or change operational ServiceM8 records.

Import maps explicit phase cells, not inferred task descriptions. All-day end dates are exclusive. Calendar timezone is the viewer's local timezone for timed bookings; weekly-grid CSV entries are date-only. CSV size limit is 2MB. Existing projects can be selected and repeated imports into the same project skip identical milestones; matching grid title/client can locate an already imported project. No real crew is inferred from availability annotations such as STEVE NA.

Migration supabase/migrations/20261109081047_post_office_workspaces.sql was applied on 9 November 2026. Jackie already had an owner account. The new workspace was initialized with the provided MPI schedule (56 milestones), nine editable checklist sections / 54 tasks, and no synthetic crew or work logs. Data writes use revision-based optimistic concurrency: a stale writer must reload instead of overwriting another person's work. Cross-company and role isolation are checked in local Postgres tests.

The signed-in Google Docs browser successfully downloaded the original checklist after unauthenticated export returned HTTP401. Its seven sections were imported, alongside separate editable production and post-production defaults. Pending: sending quotes through connected email and external calendar integrations. No claim of live signed-in owner/staff UI verification without those accounts.

Branding: official stacked logo from https://www.thepostoffice.co.nz/; public contact page confirms Auckland studio details. Logo provenance recorded in docs/design/post-office-workspace.md.

## Crew, work logs and forecasts

Crew profiles include role, contacts and optional link to an existing company login. Project assignments carry role and booking status. Work logs calculate paid time excluding breaks and productive time excluding breaks plus travel, with weekly totals. Staff writes are recomputed and authorized server-side against their mapped crew identity; managers can log for any crew member. Overnight shifts are split by date.

Forecasts reuse the existing app's Open-Meteo source, with a three-hour cache and 16-day forecast horizon. Default location is Takapuna, Auckland; managers can edit label/coordinates and rain/wind thresholds. Day cells flag risk thresholds; booking details show forecast context. These are planning risks, not official weather warnings. No forecast is invented for dates outside the horizon.

Security advisor's three authenticated SECURITY DEFINER RPC findings are intentional: staff cannot update the full workspace row; these narrow endpoints enforce auth.uid(), exact company membership, mapped crew ownership, field validation, row locks and revision increments. Anonymous EXECUTE is revoked and search_path is empty. Local Postgres tests exercise role boundaries. No policy/function warnings on unrelated TurnKey objects were changed.
