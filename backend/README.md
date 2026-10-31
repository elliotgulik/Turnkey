# TurnKey Backend

Small API server for the TurnKey CRM MVP. Implements the exact endpoints the frontend expects.

## Quick start (local)

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

Server runs at `http://localhost:3001`.

Test it:

```bash
curl http://localhost:3001/api/health
# {"ok":true,"storage":"file"}
```

## Connect the CRM

The backend URL is read automatically from `config.js` — no manual step needed.
Every route the CRM actually calls (leads, Gmail, Google Calendar, AI marketing)
authenticates with the operator's own Supabase login session, scoped server-side
to their `business_id` — there's nothing to paste in, and no shared secret for
the CRM to hold.

## Deploy to Render (recommended, ~10 min)

1. Push this repo to GitHub
2. [render.com](https://render.com) → New → **Web Service**
3. Connect the repo, set:
   - **Root directory:** `backend`
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. Environment variables:
   - `STORAGE` — `file` (default) or `supabase`
   - `NODE_VERSION` — `20`
5. Deploy → copy the URL (e.g. `https://turnkey-backend-xxxx.onrender.com`)

### File storage on Render

With `STORAGE=file`, data persists in `backend/data/` on the instance disk. Fine for MVP; upgrade to Supabase for production backups.

## Deploy with Supabase storage

1. Create a Supabase project at [supabase.com](https://supabase.com)
2. Run `supabase/schema.sql` in the SQL editor
3. Set backend env vars:
   - `STORAGE=supabase`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (server only — never put in the browser)

## API reference

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | — | Health check |
| POST | `/api/leads` | — | Receive booking page submissions. Body must include `business_id` (the CRM's booking link puts this in `?biz=`). |
| GET | `/api/leads/pending` | Supabase session (`Authorization: Bearer <token>`) | Poll for new leads, scoped to the caller's own business — the bearer token is verified against Supabase and the business_id is derived server-side from `public.users`, never trusted from the client. |
| POST | `/api/leads/ack` | Supabase session (`Authorization: Bearer <token>`) | Mark leads collected — scoped server-side to the caller's own `business_id`, so acking someone else's lead IDs is a no-op. |
| POST | `/api/leads/wix/:token` | Shared token in the URL path (SHA-256 hash compared against `lead_sources`) | A Wix Automation calls this directly, not the CRM — no Supabase session involved. Converts the form submission into a lead the same way `/api/leads` does. |
| GET | `/api/leads/meta` | Meta webhook verification (`hub.verify_token` must match `META_VERIFY_TOKEN`) | One-time handshake Meta's Webhooks product performs before it will send real events. |
| POST | `/api/leads/meta` | Meta signature (`X-Hub-Signature-256` header, verified against `META_APP_SECRET`) | Meta calls this directly on every new Lead Ads submission — no Supabase session involved. Only a `leadgen_id`/`page_id` ping; the actual lead data is then fetched from the Graph API using the matching business's stored Page token. |
| GET/POST | `/api/connections/wix/*`, `/api/connections/meta/*` | Supabase session | Connect/disconnect/status for the two lead sources above — generates the Wix webhook token, or verifies a Meta Page ID + user/System User access token. |
| GET | `/api/servicem8/status` | Supabase session | Whether this business has a ServiceM8 connection (API key or OAuth) and whether webhooks are subscribed. |
| POST | `/api/servicem8/connect/api-key`, `/oauth/start`, `/disconnect` | Supabase session | Connect via a pasted Private API Key (verified against ServiceM8 before saving), start the OAuth flow, or disconnect. |
| GET | `/api/servicem8/oauth/callback` | ServiceM8 redirects here (signed `state` param, same `signState`/`verifyState` shape as the Gmail/Calendar OAuth callbacks) | Completes the OAuth token exchange. |
| POST | `/api/servicem8/subscribe` | Supabase session | Registers this business's webhook subscriptions (Job, JobPayment, JobActivity) with a per-business callback URL/token. JobActivity requires ServiceM8 `read_schedule` permission. |
| POST | `/api/servicem8/handoff/:jobId`, `/api/servicem8/handoffs/:jobId/retry` | Supabase session | Idempotently creates/links a ServiceM8 Company + Job (+ line items + quote PDF, best-effort) for a Won TurnKey job. Retry is the exact same code path — safe to call repeatedly. |
| GET | `/api/servicem8/handoffs` | Supabase session | Transfer history/status for the Connections card (pending/synced/failed). |
| POST | `/api/servicem8/webhook/:token` | Per-business token in the URL path (SHA-256 hash compared against `servicem8_connections`) | ServiceM8 calls this directly on Job/JobPayment/JobActivity changes — no Supabase session involved. Handles both the one-time verification handshake and real events; payload only carries an object uuid, so every event means re-fetching it via our stored credential. |
| POST | `/api/email/*`, `/api/calendar/*`, `/api/ai/marketing` | Supabase session (`Authorization: Bearer <token>`) | Gmail, Google Calendar and AI marketing — all resolve `business_id`/`user_id` server-side from the caller's own session. |
| GET | `/api/payments/status` | Supabase session | Whether Stripe (and its webhook) are configured on this deployment — lets the CRM show accurate connected/not-set-up state. |
| POST | `/api/payments/create-link` | Supabase session | Creates a Stripe Payment Link for an invoice. |
| POST | `/api/payments/webhook` | Stripe signature (`Stripe-Signature` header, verified against `STRIPE_WEBHOOK_SECRET`) | Stripe calls this directly, not the CRM — no Supabase session involved. On a paid checkout, marks the matching invoice and job paid automatically. |

## Wix & Meta lead webhooks (optional)

Both land straight into the same Leads pipeline the booking page already feeds — no changes needed anywhere else in the CRM.

**Wix**: in the CRM, Settings → Connections → Wix → Connect generates a one-time webhook URL (shown once — copy it immediately, regenerating invalidates the old one). Paste it into a Wix Automation: *When a form is submitted → Send a webhook*. No server-wide env var needed; the secret is per-business.

**Meta**: set `META_APP_ID`, `META_APP_SECRET`, and `META_VERIFY_TOKEN` on Render. The App ID and App Secret let the backend validate and, when Meta permits, exchange a short-lived user token; the secret also verifies webhook signatures. In Meta Graph API Explorer, select the TurnKey CRM app, generate a **User Token** with `leads_retrieval` and `pages_manage_metadata`, and ensure the signed-in user has lead access to the Page. The Connections panel takes the Page ID and this one token. TurnKey checks that the token belongs to this app, derives the Page token server-side, encrypts both tokens, and reuses them for lead retrieval and webhook delivery. Add `ads_read` only if ad reporting is needed; it does not block lead capture. A personal user token can still expire or be revoked; Meta does not guarantee a permanent user token. Configure the Meta app's `leadgen` webhook to `https://<this-backend>/api/leads/meta` with the same `META_VERIFY_TOKEN` set on Render.

## ServiceM8 (optional, in progress)

Handles the handoff when a TurnKey sale is won: creates/links a Company and Job in the business's connected ServiceM8 account, attaches the approved quote's line items and PDF, and stores the mapping so a repeated "Won" event never creates a duplicate. Inbound webhooks (Job/JobPayment changes) are received and durably logged; writing a status change back onto the right TurnKey record is scaffolded but not yet implemented (see `servicem8Routes.js`'s `onObjectChanged`).

**Connect** (either path, in Settings → Connections → ServiceM8):
- **Private API Key** — paste a key from the business's own ServiceM8 account (Settings → API Keys). No server-wide config needed, works immediately.
- **OAuth** — needs `SERVICEM8_CLIENT_ID`/`SERVICEM8_CLIENT_SECRET` set on this server (see `.env.example`), which requires registering as a ServiceM8 Development Partner first. Required for connecting separate customer accounts rather than just this one.

**Enable live sync**: after connecting, `POST /api/servicem8/subscribe` registers the webhook subscriptions and generates this business's unique callback URL/token — needed because ServiceM8's webhook payload carries no account identifier at all, so without a per-business URL there'd be no way to tell two connected businesses' events apart.

**Known gaps, called out deliberately rather than papered over:**
- Record **update** semantics (editing an existing ServiceM8 Company/Job after creation) are not implemented — developer-forum reports disagree on whether PATCH works at all, and this wasn't independently verified against a live sandbox. `providers/servicem8.js` exports `updateObjectUnverified()` but nothing calls it.
- No company-lookup-by-email before creating a new one — if a business already had a customer in ServiceM8 before connecting TurnKey, the first handoff creates a second Company rather than finding the existing one. ServiceM8's `$filter` query syntax wasn't verified against the live API.
- ServiceM8 doesn't document a signature header on webhook event deliveries (unlike Meta's `X-Hub-Signature-256` or Stripe's `Stripe-Signature`) — mitigated architecturally rather than cryptographically: a forged callback can only trigger a re-fetch of whatever object uuid it names, using this server's own stored credential, scoped to the one connected account; it can't inject data directly. Revisit if ServiceM8's docs turn out to describe a scheme this pass didn't find.
- One ServiceM8 connection per business (`servicem8_connections.business_id` is unique) — correct for this integration's intended shape, just noting it's an assumption, not a documented ServiceM8 constraint.

## Stripe (optional)

Card payments work once you set two env vars — this is a one-time setup on the server, not something each business configures individually:

1. `STRIPE_SECRET_KEY` — from [dashboard.stripe.com](https://dashboard.stripe.com) (use a `sk_test_...` key first)
2. `STRIPE_WEBHOOK_SECRET` — create a webhook endpoint in the Stripe dashboard pointing at `https://<your-backend>/api/payments/webhook`, subscribed to the `checkout.session.completed` event, then copy its signing secret (`whsec_...`)

Without `STRIPE_WEBHOOK_SECRET` set, payment links still work (`create-link` only needs `STRIPE_SECRET_KEY`), but a paid invoice won't mark itself paid automatically — someone has to notice the payment and mark it paid by hand, same as today.

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are required unconditionally (not just when `STORAGE=supabase`) — they're used to verify the CRM's Supabase session on every authenticated route.

There is no shared access-code / `SYNC_KEY` anywhere in this backend — every route is either public-by-design (`/api/leads`, rate-limited and validated server-side) or scoped per-business via a verified Supabase session. An earlier version had a whole-app `/api/state` push/pull sync gated by one shared key with no per-business scoping at all — it's been removed; it was a genuine cross-tenant risk (any business's key could overwrite every other business's data) and had no remaining caller in the CRM.

## Booking page

Set `TURNKEY_BACKEND_URL` in Netlify (or edit `config.js`) so customer quote requests POST to `/api/leads` without needing localStorage on their device.

Each business shares its own link: `https://your-site.netlify.app/booking.html?biz=<their business_id>` (find it in the CRM's Connections panel). The `?biz=` value is what tags submitted leads so they land in the right business's pipeline — a generic `/booking.html` link with no `?biz=` will be rejected by `/api/leads`.

## Sales platform integration adapter

The current frontend uses `/api/sales/servicem8/*`, with durable tasks, browser-bound OAuth state, connection role checks and generation-scoped mappings. The tokened webhook remains `/api/servicem8/webhook/:token`; other legacy ServiceM8 router endpoints listed above return HTTP 410. The original implementation files remain unchanged for provenance. Apply the canonical schema followed by both sales-platform migrations, and configure PUBLIC_BACKEND_URL / FRONTEND_URL. See [the connection guide](../docs/CONNECTIONS_SETUP.md) and [release report](../docs/DEPLOYMENT_REPORT.md) for exact setup and verified deployment state.
