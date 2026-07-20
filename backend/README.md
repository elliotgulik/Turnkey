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
| POST | `/api/email/*`, `/api/calendar/*`, `/api/ai/marketing` | Supabase session (`Authorization: Bearer <token>`) | Gmail, Google Calendar and AI marketing — all resolve `business_id`/`user_id` server-side from the caller's own session. |
| GET | `/api/payments/status` | Supabase session | Whether Stripe (and its webhook) are configured on this deployment — lets the CRM show accurate connected/not-set-up state. |
| POST | `/api/payments/create-link` | Supabase session | Creates a Stripe Payment Link for an invoice. |
| POST | `/api/payments/webhook` | Stripe signature (`Stripe-Signature` header, verified against `STRIPE_WEBHOOK_SECRET`) | Stripe calls this directly, not the CRM — no Supabase session involved. On a paid checkout, marks the matching invoice and job paid automatically. |

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
