# TurnKey CRM

Service-business CRM: pipeline, quoting, scheduling, jobs, invoicing, and a customer booking page.

## Stack

| Layer | Tech | Host |
|-------|------|------|
| CRM app | Static HTML PWA (`index.html`) | Netlify |
| Booking page | `booking.html` | Netlify |
| Backend API | Node + Express | Render / Railway |
| Database (optional) | Supabase Postgres | Supabase |

## Project layout

```
index.html          # CRM app (pipeline, quotes, jobs…)
booking.html        # Customer quote tool
config.js           # Public backend URL for booking page
backend/            # API server (sync + lead inbox)
scripts/            # Netlify build helpers
docs/               # Setup and workflow guides
```

## Quick start

### 1. Frontend (local)

Open `index.html` in a browser, or:

```bash
npx serve .
```

### 2. Backend (local)

```bash
npm run backend:install
cd backend && cp .env.example .env
# Set SYNC_KEY in backend/.env
npm run backend
```

### 3. Connect

CRM → Connections → paste backend URL + SYNC_KEY.

## Deploy

See `docs/DEPLOY.md` for Netlify + Render + Supabase steps.

## Dev tools

This repo is designed for **Cursor**, **Claude Code**, and **ChatGPT** working together. See `docs/WORKFLOW.md`.

## Commands

```bash
npm run config          # Regenerate config.js from TURNKEY_BACKEND_URL
npm run backend:install # Install backend deps
npm run backend         # Run backend locally (port 3001)
```
