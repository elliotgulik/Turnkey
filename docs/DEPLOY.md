# Deploy TurnKey

## Overview

Two deployments, one CRM:

1. **Netlify** — hosts the CRM + booking page (static files)
2. **Render** — hosts the backend API (sync + lead inbox)

Optional: **Supabase** — Postgres storage behind the backend.

---

## Step 1 — Push to GitHub

```bash
cd ~/Projects/TurnKey
git add .
git commit -m "TurnKey MVP with backend"
git remote add origin https://github.com/YOUR_USER/turnkey.git
git push -u origin main
```

---

## Step 2 — Deploy backend to Render

1. Go to [render.com](https://render.com) → **New Web Service**
2. Connect your GitHub repo
3. Settings:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free (fine for MVP)
4. Environment variables:

   | Key | Value |
   |-----|-------|
   | `SYNC_KEY` | Long random secret — e.g. `openssl rand -hex 32` |
   | `STORAGE` | `file` (or `supabase` — see Step 4) |
   | `NODE_VERSION` | `20` |

5. Deploy → note your URL: `https://turnkey-backend-xxxx.onrender.com`
6. Test: `curl https://turnkey-backend-xxxx.onrender.com/api/health`

**Save your SYNC_KEY** — this is the access code you paste into the CRM Connections panel.

---

## Step 3 — Deploy frontend to Netlify

1. Go to [app.netlify.com](https://app.netlify.com) → **Add new site** → Import from Git
2. Connect the same repo
3. Build settings (auto-detected from `netlify.toml`):
   - **Build command:** `node scripts/generate-config.js`
   - **Publish directory:** `.` (repo root)
4. Environment variables:

   | Key | Value |
   |-----|-------|
   | `TURNKEY_BACKEND_URL` | Your Render URL (no trailing slash) |
   | `NODE_VERSION` | `20` |

5. Deploy → note your URL: `https://turnkey.netlify.app`

The build writes `config.js` so `booking.html` sends leads to your backend automatically.

---

## Step 4 — Connect the CRM

1. Open your Netlify URL on phone or laptop
2. Tap **Connections** in the header
3. Enter:
   - **Backend URL:** `https://turnkey-backend-xxxx.onrender.com`
   - **Access code:** your `SYNC_KEY`
4. Tap **Connect** → should show **● LIVE**
5. Open the same URL on a second device with the same credentials → data syncs

### Customer booking page

Share: `https://your-site.netlify.app/booking.html`

Quote requests land in your pipeline within 30 seconds.

---

## Step 4b — Upgrade to Supabase (optional)

For production-grade persistence and backups:

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard)
2. SQL Editor → run `backend/supabase/schema.sql`
3. On Render, update env vars:
   - `STORAGE=supabase`
   - `SUPABASE_URL=https://xxx.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY=...` (from Supabase → Settings → API)

Redeploy Render. The CRM frontend does not change.

---

## Step 5 — Install as phone app

1. Open Netlify URL on your phone
2. **iPhone:** Safari → Share → Add to Home Screen
3. **Android:** Chrome → Install app prompt

Works offline with cached shell; syncs when backend is connected.

---

## Optional integrations

| Integration | Where to configure |
|-------------|-------------------|
| Google Maps satellite | CRM → Connections → paste Maps API key |
| Gmail auto-send | Backend Gmail OAuth env vars (needs Google verification) |
| Custom domain | Netlify → Domain settings |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Could not reach that URL" | Check Render service is running; URL has no trailing slash |
| Booking leads not appearing | Verify `TURNKEY_BACKEND_URL` is set in Netlify env and redeployed |
| Data not syncing between devices | Same backend URL + SYNC_KEY on both devices |
| Render free tier sleeps | First request after idle takes ~30s; upgrade or use a keep-alive ping |
