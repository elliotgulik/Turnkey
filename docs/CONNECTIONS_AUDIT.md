# Connection audit

Read-only observations, 15 October 2026; backend health timestamp `2026-10-15T06:47:34.417Z`. No deployments, schema changes, provider connections, credential mutations, messages, commits or pushes performed. Only the two assigned connection docs were written. Other agents own concurrent implementation changes.

## Confirmed live evidence

- Public `https://turnkeycrm.net/config.js`: HTTP 200, JavaScript. Runtime backend URL is `https://turnkeynova.onrender.com`; Supabase URL is `https://rcighpmdrutnghsqhzlr.supabase.co`. Public anon and Maps fields are nonempty; values were not printed. Key presence does not prove provider validity.
- `https://turnkeynova.onrender.com/api/health`: HTTP success JSON, `ok:true`, `storage:supabase`. This endpoint reports process configuration, not a database/provider connectivity test.
- Supabase connector lists **TurnKey CRM**, project `rcighpmdrutnghsqhzlr`, `ACTIVE_HEALTHY`, Sydney region. Separate project named Turnkey is inactive and is not the target.
- Read-only `information_schema.tables` inspection: `email_accounts` and `lead_sources` exist. None of the queried `servicem8_connections`, `sales_settings`, `sales_goals`, `sales_spend`, `integration_tasks`, `integration_oauth_states`, `external_object_mappings` exists in public at audit time. The sales/integration schema is therefore not live-ready.
- Aggregate-only queries: one Wix lead-source record, two Gmail account records; no Meta lead-source records and no Calendar connection records. No business IDs, email addresses, tokens or encrypted credential columns were retrieved. Counts span the project, not necessarily one business.
- Both public `GET /api/sales/servicem8/status` and `GET /api/servicem8/status` return Express HTTP 404 `Cannot GET ...`, rather than an authentication rejection. The expected ServiceM8 routes are not available on the currently configured backend. A healthy process does not establish deployment of the working-tree overhaul.

## Connection classification

- Netlify frontend and Render backend: reachable public deployments; dashboard ownership, live environment variable names, deployed revision and build settings unverified.
- Supabase: authenticated read-only project access confirmed; pending sales and canonical ServiceM8 schema are deployment blockers.
- Wix: saved configuration exists; actual Wix Automation activation, webhook URL validity and delivery unverified. Do not regenerate the token to inspect it.
- Gmail: two saved configurations exist; active backend OAuth environment, token refresh, consent status and send/inbox operation unverified.
- Maps: runtime key present; API enablement, restrictions, billing and functional calls unverified.
- Meta: no saved connection in the target project; app secrets, Page subscription and app permissions unverified. Repository uses manual Page token entry, not Meta OAuth, and hardcoded Graph `v19.0` needs validation.
- ServiceM8: no canonical connection table and neither public status route available; not operational through this deployment. Local code includes the intended integration, which is not live evidence.
- Google Calendar: table exists but no saved connections; no live connection established by evidence.

## Tool and dashboard availability

- Supabase MCP authenticated project listing and SELECT queries work. No DDL or migration operation was performed.
- No `netlify`, `render`, `supabase` or `gh` CLI executable found on PATH; no local `.netlify/state.json` or `supabase/.temp/project-ref` marker. CLI authenticated deployment access was not established. No Netlify or Render deployment connector was exposed in the available tool inventory.
- Browser inventory showed an in-app browser with no open tabs. Main independently checked Netlify: no signed-in session; Google login reached a blank email sign-in, and no credentials were entered. Netlify and Google console configuration needs user sign-in. Render, Wix, Meta and ServiceM8 dashboard authentication was not established; no new sign-in attempted here.
- Shell network access initially failed DNS under restrictions; an approved read-only network check succeeded. Public HTTP checks are usable with network permission. Web search could not fetch the application URLs but official provider documentation was accessible.
- Local backend `.env` variable-name-only inspection found `PORT`, `STORAGE`, `SYNC_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. No Gmail, Calendar, ServiceM8 or Meta configuration variable names were present there. This says nothing about Render's environment. No secret values were printed or used.

## Practical handoff to main

1. Review/apply the sales migration and canonical ServiceM8 prerequisites to the correct existing project under the main task's authorization. Deploy backend routes before enabling the sales integration UI. Existing protected ServiceM8 files remain untouched by this audit.
2. Confirm Render environment names and frontend origin using dashboard access when available. Preserve all existing token-encryption secrets. The new adapter's `oauthConfigured` requires ServiceM8 client ID/secret, encryption key and HTTPS `PUBLIC_BACKEND_URL`.
3. Keep `/api/sales/servicem8/*` for sales UI calls, `/api/servicem8/*` for the protected legacy router, and one `servicem8_connections` table. Verify compatibility rather than creating parallel credentials.
4. Main changed Netlify to `scripts/build-static.js` and `.netlify-dist`; these working-tree changes were inspected, not deployed or built by this agent. Confirm Netlify deploy logs use them and do not expose server/archive/test files. Old DEPLOY.md instructions are stale.
5. Once dashboards are signed in, verify existing Wix and Gmail connections before changing them. Meta needs first saved Page connection plus provider-side subscription; Maps needs separate functional API checks. Follow CONNECTIONS_SETUP.md for exact endpoint namespaces and verification options.

Provider requirements and official references are linked in CONNECTIONS_SETUP.md. These documents do not assert that pending deployment or provider setup has been completed.
