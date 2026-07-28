# supabase/migrations/

This directory is new. Until now, TurnKey's database schema lived entirely
as 25 hand-run `.sql` files under `backend/supabase/`, applied by pasting
each one into the Supabase SQL editor in whatever order its own comments
implied — no `supabase/migrations/` folder, no Supabase CLI project link, no
applied-migrations ledger. `CLAUDE.md` and `.cursor/rules/turnkey.mdc`
describe this directory (and `supabase db push`, and a generated
`src/lib/database.types.ts`) as if it already existed — it didn't. This is
the actual start of it.

## What's in here so far

**`20240101000000_baseline_jobs_quotes_invoices.sql`** — a best-effort
reconstruction of `public.jobs`, `public.quotes`, and `public.invoices`.
These three are the most-used tables in the entire app and had **no
`CREATE TABLE` anywhere in the repo** — only `ALTER TABLE`s against tables
originally hand-created in the Supabase dashboard. A fresh clone of this
repo could not stand up a working database before this file existed.

Read that file's own header comment before trusting it — every column is
sourced from either a real `ALTER TABLE` elsewhere in `backend/supabase/`,
or an actual `.insert()`/`.update()` payload in the app code (Supabase
rejects writes to a nonexistent column, so those are reliable evidence
too). One column (`invoices.created_at`) is marked unconfirmed because no
code was found reading or writing it directly. **Verify this file's column
list against Supabase Studio's own table editor before relying on it for
disaster recovery or standing up a new environment** — it's the best
reconstruction the evidence in this repo supports, not a confirmed mirror
of production.

It's written as `if not exists`/idempotent throughout, so running it
against the real production database (where these tables already exist)
does nothing. It only matters for a genuinely fresh environment.

**`20260727120000_fix_invite_matching_and_activity.sql`** — this one
*does* need to be run against production; it's a real fix, not a
reconstruction. Two changes: `handle_new_user()` now matches a pending
invite's email case-insensitively and trimmed (it previously did an exact
string comparison, so "John@email.com" invited vs "john@email.com" signed
up silently failed to match and the invite stayed pending forever); and a
new `public.users.last_seen_at` column + column grant, updated by a
heartbeat from the authenticated frontend session, backing the Team page's
Active now/Recently active/Offline status with real data instead of a
guess.

**`20260727130000_users_realtime_for_team_join.sql`**, **`20260728100000_business_home_address_for_travel_cost.sql`**, **`20260728110000_business_branding_and_policies.sql`** — real fixes, need to be run against production. Add `public.users` to the realtime publication (team-join notifications); add `businesses.home_address/home_lat/home_lng` (real travel-distance cost calculation, replacing a hardcoded km guess); add `businesses.primary_color/font_style/header_style/quote_intro_message/policies_config` plus an updated `get_public_quote()` (per-business branding + a real Terms & Policies system for the customer-facing quote/booking pages, replacing hardcoded "Turnkey" copy). Each file's own header comment has the full rationale.

**`20260728120000_notification_system_fixes.sql`** — real fix, needs to be run against production. `notification_preferences.event`'s check constraint only ever allowed 8 of the 16 event types Settings → Notifications actually shows — every save has been silently failing for the other 8 (quote_sent, quote_declined, customer_question, job_rescheduled, job_cancelled, job_today, invoice_created, customer_approved_work), so those toggles have never actually persisted. Expanded to the full list plus a new `job_started` event. Also adds `notifications.data` (jsonb). Does NOT fix push delivery itself — that's an environment variable, not a schema issue; see the file's own header comment and the session report.

**`20260728130000_email_accounts_updated_at.sql`** — small real fix, needs to be run against production. Adds `email_accounts.updated_at` (the table otherwise already matches what a Gmail-OAuth audit expects — see `backend/supabase/schema-email.sql` — tokens are stored encrypted, not plaintext, deliberately).

## What's NOT in here yet

Everything else — `customers`, `users`, `businesses`, `attachments`,
`activity_log`, the email/calendar/notification tables, the import
wizard's RPCs, and so on — still only exists in `backend/supabase/*.sql`.
Those files are not being touched or migrated into this format as part of
this change; that would be a much larger, separate effort. This directory
currently only closes the specific "three core tables have no CREATE
TABLE" gap.

## Going forward

New schema changes should be added here as new timestamped files
(`YYYYMMDDHHMMSS_description.sql`), not as a new file dropped into
`backend/supabase/`. `backend/supabase/*.sql` remains as-is — it's the
historical record of how the live database actually got to its current
state, and several of those files (e.g. `schema-security-fix.sql`,
`fix-rls-recursion.sql`) fixed real bugs that are worth keeping visible as
history, not deleting or rewriting.

If/when the Supabase CLI is actually linked to this project
(`supabase link`), this folder is where `supabase db pull` /
`supabase db push` will read from — right now it isn't linked, so treat
these files as documentation-plus-idempotent-repair-scripts rather than a
CLI-managed migration history until that's set up.
