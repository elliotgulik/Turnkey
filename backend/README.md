# TurnKey Backend

Small API server for the TurnKey CRM MVP. Implements the exact endpoints the frontend expects.

## Quick start (local)

```bash
cd backend
cp .env.example .env
# Edit .env — set SYNC_KEY to any long random string
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

1. Deploy this backend (see below)
2. Open the CRM → **Connections** → paste:
   - **URL:** `https://your-backend.onrender.com`
   - **Access code:** same value as `SYNC_KEY`
3. Status should show **● LIVE**

## Deploy to Render (recommended, ~10 min)

1. Push this repo to GitHub
2. [render.com](https://render.com) → New → **Web Service**
3. Connect the repo, set:
   - **Root directory:** `backend`
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. Environment variables:
   - `SYNC_KEY` — long random secret (this is your CRM access code)
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
| GET | `/api/state` | `X-Turnkey-Key` | Pull CRM state |
| POST | `/api/state` | `X-Turnkey-Key` | Push CRM state |
| POST | `/api/leads` | — | Receive booking page submissions. Body must include `business_id` (the CRM's booking link puts this in `?biz=`). |
| GET | `/api/leads/pending` | `X-Turnkey-Key` + Supabase session (`Authorization: Bearer <token>`) | Poll for new leads, scoped to the caller's own business — the bearer token is verified against Supabase and the business_id is derived server-side, never trusted from the client. |
| POST | `/api/leads/ack` | `X-Turnkey-Key` | Mark leads collected |
| GET | `/api/gmail/status` | `X-Turnkey-Key` | Gmail integration status |

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are required unconditionally now (not just when `STORAGE=supabase`) — they're used to verify the CRM's Supabase session on every `/api/leads/pending` poll.

## Booking page

Set `TURNKEY_BACKEND_URL` in Netlify (or edit `config.js`) so customer quote requests POST to `/api/leads` without needing localStorage on their device.

Each business shares its own link: `https://your-site.netlify.app/booking.html?biz=<their business_id>` (find it in the CRM's Connections panel). The `?biz=` value is what tags submitted leads so they land in the right business's pipeline — a generic `/booking.html` link with no `?biz=` will be rejected by `/api/leads`.
