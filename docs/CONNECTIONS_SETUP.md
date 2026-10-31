# Connection and deployment setup

Checked 15 October 2026. See CONNECTIONS_AUDIT.md for observed live state. This is a setup checklist, not confirmation that these steps have been performed.

## Deployment configuration

- Frontend: https://turnkeycrm.net. Current working-tree Netlify configuration runs `node scripts/build-static.js`, publishing `.netlify-dist` with browser assets only. Main owns build validation and deployment. Do not use the older repo-root publish instructions in DEPLOY.md.
- Netlify build variables: `TURNKEY_BACKEND_URL=https://turnkeynova.onrender.com`, `TURNKEY_SUPABASE_URL=https://rcighpmdrutnghsqhzlr.supabase.co`, and `TURNKEY_SUPABASE_ANON_KEY` (public frontend key). Optional: `TURNKEY_MAPS_KEY`, `TURNKEY_ONESIGNAL_APP_ID`. Verify Production build scope. Missing any of the first three leaves the existing config untouched; missing optional keys preserves values in the build's existing config, not necessarily the previous deployed artifact.
- Backend: https://turnkeynova.onrender.com. Expected Render service configuration from repository: root `backend`, build `npm install`, start `npm start`, Node 20+. Render dashboard verified: this exact service uses main, root backend, npm install, npm start, and Auto-Deploy. PUBLIC_BACKEND_URL and FRONTEND_URL were added with Save only for the next release; existing secrets were preserved.
- Backend variables: `SUPABASE_URL` for the same project, `SUPABASE_SERVICE_ROLE_KEY` backend-only, `STORAGE=supabase`; preserve existing secrets. Sales ServiceM8 additionally needs `PUBLIC_BACKEND_URL=https://turnkeynova.onrender.com`, `FRONTEND_URL=https://turnkeycrm.net`, `SERVICEM8_CLIENT_ID`, `SERVICEM8_CLIENT_SECRET`, and `EMAIL_TOKEN_KEY`. Preserve the existing encryption key: replacing it can make stored tokens unreadable. `OAUTH_STATE_SECRET` is used by existing OAuth flows and falls back to the service role key.
- Supabase: use existing **TurnKey CRM**, project `rcighpmdrutnghsqhzlr`, not the separate inactive project named Turnkey. The required canonical ServiceM8 schema and sales migration were applied together successfully; secure_lead_sources was applied afterward. Confirm RLS, grants, integration task RPCs and existing-connection compatibility before backend rollout.

## ServiceM8

The sales UI uses `/api/sales/servicem8/*`. The protected legacy router files remain unchanged, but legacy connection API paths return HTTP 410 to prevent bypassing the safer adapter. The tokened webhook remains active. Both use canonical `servicem8_connections`; do not create a parallel credential table or replace protected files.

Sales endpoints include `GET /status`, `GET /oauth/prepare`, `GET /oauth/start`, and `GET /oauth/callback/:state`, all relative to `/api/sales/servicem8`. The callback state is a dynamically generated path component. Set the ServiceM8 Store Connect Return URL on the backend host; ServiceM8 requires the supplied redirect URI to have the same host, and token exchange must use the identical redirect URI. Use the sales callback above; the legacy OAuth callback is retired.

Use the UI popup flow: it establishes a secure browser cookie and validates the opener against `FRONTEND_URL`. Integration changes require owner/manager access. Confirm exact-origin credentialed CORS and popup behavior. The current adapter registers job/jobpayment webhooks at `/api/servicem8/webhook/:token`; keep the token-bearing URL private.

Match the sales adapter's requested scopes in `backend/src/salesTransfer.js`. OAuth/public applications are required for some ServiceM8 features including webhooks; private API-key mode is not evidence that webhook subscriptions work. `ENABLE_SERVICEM8_PRIVATE=false` disables the testing entry point. Do not enter keys, authorize a new connection, transfer jobs or retry tasks during a read-only audit. Job creation may incur account charges.

[ServiceM8 authentication and redirect rules](https://developer.servicem8.com/docs/authentication)

## Gmail and Google Calendar

Gmail needs Gmail API enabled, a Web application OAuth client, consent configuration and backend `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `EMAIL_TOKEN_KEY`. Register exact redirect URI `https://turnkeynova.onrender.com/api/email/oauth/callback/gmail`. Start through `/api/email/oauth/start`; the frontend reads `email_accounts_status` for connection state. Requested scopes include `gmail.send`, `gmail.readonly`, `userinfo.email`, `openid`. Gmail readonly is restricted; check verification requirements and consent audience/test users before wider rollout. A stored account does not prove refresh-token validity. Do not send mail as a deployment check.

Calendar optionally uses `GOOGLE_CALENDAR_CLIENT_ID`/`GOOGLE_CALENDAR_CLIENT_SECRET`, falling back to the Gmail client. Set Render `PUBLIC_BACKEND_URL` to `https://turnkeynova.onrender.com`. In the Google Cloud OAuth Web client, add this exact Authorized redirect URI: `https://turnkeynova.onrender.com/api/calendar/oauth/callback/google`. The backend now pins both OAuth steps to this URI; a mismatch is a common cause of Google's “Access blocked / invalid request” screen. Enable Calendar API. The requested scopes are `calendar.events`, `calendar.readonly`, and `openid`. If Google still blocks the request after the URI matches, check that the OAuth consent screen is configured, your Google account is listed as a test user while the app is in Testing, and the client ID/secret on Render belong to that same Cloud project.

[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Google OAuth web-server setup](https://developers.google.com/identity/protocols/oauth2/web-server)

## Google Maps

The deployed runtime has a nonempty Maps key; provider acceptance, billing and restrictions are unverified. Existing code calls Maps JavaScript with Places, Static Maps, Geocoding and Distance Matrix. Check enabled APIs, existing billing and supported browser/request restrictions for each API; do not assume a browser referrer restriction makes every REST call work. Restrict the browser key to the actual frontend domains and required APIs. Test address search, satellite map and travel lookup separately. No billing activation or paid resources are authorized for this audit.

[Maps key security guidance](https://developers.google.com/maps/api-security-best-practices)

## Wix

One saved source exists. Inspect the existing Wix Automation before reconnecting: `POST /api/connections/wix/connect` replaces the saved token hash and returns a new private webhook URL, invalidating the old one. Status is `GET /api/connections/wix/status`; delivery is `POST /api/leads/wix/:token`.

Use Wix Automation's Send HTTP request action with JSON fields `name`, `email`, `phone`, `address`, `message`, and stable top-level `submissionId` for deduplication. Body may also use `data` or `contact` wrappers for customer fields. Keep the automation active. No server-wide Wix credential is needed. A later authorized test submission must appear once in the intended business; do not create a test lead during this read-only audit.

[Wix HTTP request action](https://support.wix.com/en/article/the-new-automation-builder-sending-data-via-webhook)

## Meta Lead Ads

Needs backend `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, and `EMAIL_TOKEN_KEY`, plus the TurnKey Meta app and an assigned System User. Generate a System User token for the TurnKey app with expiration set to **Never** and `leads_retrieval`, `pages_manage_metadata`, and `ads_read`. Assign the System User the Nova Exterior Page and ad account, and allow the app under the Page's Leads Access settings. In TurnKey Connections enter the Page ID and this one token; never enter a Meta user ID or a Page token. The backend checks that it is a valid, non-expiring System User token for the configured TurnKey app, retrieves the Page token itself, and stores both encrypted server-side. Webhook callback: `https://turnkeynova.onrender.com/api/leads/meta` (GET verification, POST signed events). Subscribe the Page to `leadgen`. Production use may require Meta app review/advanced access. Meta can revoke a token if the app, System User, Page or permissions are changed.

TurnKey uses the backend-verified System User token through `POST /api/connections/meta/connect`; it does not implement Meta OAuth. `GET /api/connections/meta/status` only proves a saved Page mapping, while the Check connection action verifies provider access. Connecting attempts to subscribe the Page to lead notifications. The Graph API version is configurable; confirm the app's configured version and permissions before production use.

[Meta's lead retrieval setup checker](https://github.com/facebookincubator/catalogue-of-api-solutions/blob/main/solutions/leads/leads-retrieval-set-up-checker.md)

## Verification after an authorized rollout

1. Verify build logs and public `/config.js` URLs/key presence without copying values. Confirm new sales assets are served as JavaScript/CSS, not HTML from the fallback route.
2. Check backend `GET /api/health`. Healthy does not prove migrations or provider configuration.
3. Confirm the sales ServiceM8 status endpoint returns authentication rejection without credentials, and retired legacy connection routes return 410. In an existing signed-in business session, read sales status and verify `oauthConfigured`, account identity and errors. Do not click connect/disconnect/refresh/retry as a read-only check: these mutate state or call providers.
4. Read connection status views and provider dashboards with existing authorized sessions. Inspect saved connection metadata only, never encrypted credential columns.
5. Separately authorize end-to-end provider tests; record delivery, token refresh and business isolation evidence before calling an integration operational.

## Updated account observations during release

Render contains EMAIL_TOKEN_KEY, GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET (values were not revealed). No ServiceM8 or Meta environment credentials are configured there. The signed-in TurnKey business displays Gmail and Wix as connected; that is saved-state evidence, not a fresh provider delivery/refresh test. No Wix token was regenerated, no existing connection was disconnected, and no customer email or remote job was sent during these checks.
