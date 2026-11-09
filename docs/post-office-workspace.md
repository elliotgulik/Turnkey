# The Post Office: local custom workspace

Owner: jackie@thepostoffice.co.nz. This work is local, not deployed. It does not provision, invite, reassign or merge any account.

Preview: http://127.0.0.1:8881/post-office.html?demo=1 . Demo mode is enabled only on loopback hosts, uses sessionStorage in the preview tab, and never reads or writes company records. Do not treat preview imports as live imports. Export a workspace backup before closing the preview tab if you want to retain it.

Production route is post-office.html. It uses existing Supabase sign-in and requires Jackie's email plus owner/manager role. Other TurnKey accounts retain their existing application. A Production workspace link is added only for Jackie. Database RLS also scopes every row to the current business and requires Jackie to belong to that business. The separate workspace stores no exterior-cleaning settings and changes none of the shared pricing engines.

Implemented: month/week/day/agenda calendar, all-project/per-project and production-phase filters; editable bookings and milestones; weekly-grid and standard CSV preview/import with duplicates skipped; projects with client/agency/contact, brief, deliverables and current phase; crew by role/name/contact/booking status; per-project checklists with category-specific reusable editable templates; custom category names/colours; editable itemised production quotes with quantity/unit/sell rate/internal cost, ex-GST subtotal, configurable GST, cost/margin and clean printable customer PDF preview. Rates are deliberately not supplied as actual business pricing is unknown. Quote PDF export uses browser Print / Save PDF. It does not send emails or change operational ServiceM8 records.

Import maps explicit phase cells, not inferred task descriptions. All-day end dates are exclusive. Calendar timezone is the viewer's local timezone for timed bookings; weekly-grid CSV entries are date-only. CSV size limit is 2MB. Existing projects can be selected and repeated imports into the same project skip identical milestones; matching grid title/client can locate an already imported project. No real crew is inferred from availability annotations such as STEVE NA.

Before live use, review/apply supabase/migrations/20261109081047_post_office_workspaces.sql and establish Jackie's own separate company account if absent. Migration has NOT been applied. Data writes use revision-based optimistic concurrency: a stale writer must reload instead of overwriting another person's work. Cross-company and role isolation are checked in local Postgres tests.

Pending: exact checklist in linked Google Doc (public export returns HTTP401), live account provisioning/connection, sending quotes through connected email, external calendar integrations, live deployment. No claims of production verification.

Branding: official stacked logo from https://www.thepostoffice.co.nz/; public contact page confirms Auckland studio details. Logo provenance recorded in docs/design/post-office-workspace.md.
