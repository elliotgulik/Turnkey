# TurnKey CRM

TurnKey is a CRM built with React + Vite, Supabase (backend), and Netlify (hosting).

## Stack

- **Frontend**: React 19, TypeScript, Vite, React Router
- **Backend**: Supabase (Postgres, Auth, RLS, migrations)
- **Hosting**: Netlify (static SPA + redirects)
- **Dev tools**: Cursor (primary IDE), Claude Code (terminal agent), ChatGPT (second opinion / planning)

## Project layout

```
src/
  components/   # shared UI
  pages/        # route-level views
  lib/          # supabase client, generated types
  types/        # app-level types
supabase/
  migrations/   # SQL schema changes
  config.toml   # local Supabase config
```

## Commands

```bash
npm install
npm run dev              # http://localhost:5173
npm run build            # production build
supabase start           # local Supabase (requires Supabase CLI)
supabase db push         # apply migrations to linked project
npm run db:types         # regenerate TypeScript types from DB
```

## Environment

The actual frontend (`index.html`, `booking.html`, `quote.html`) is plain
JS/HTML with no build step — it reads runtime config from `window.TURNKEY_CONFIG`,
populated by `config.js`. `config.js` is itself generated at Netlify build time
by `scripts/generate-config.js` (the build command in `netlify.toml`) from
these environment variables, set in Netlify → Site settings → Environment
variables (see `.env.example` for local reference):

- `TURNKEY_BACKEND_URL`
- `TURNKEY_SUPABASE_URL`
- `TURNKEY_SUPABASE_ANON_KEY`
- `TURNKEY_MAPS_KEY` — Google Maps (Static Maps + Geocoding + Places). Optional:
  if unset, the app falls back to a free OpenStreetMap view. Restrict the key
  by HTTP referrer in Google Cloud Console rather than keeping it secret.

If the three required vars aren't all set, the build leaves the committed
`config.js` untouched rather than overwriting it with blanks. `TURNKEY_MAPS_KEY`
is handled separately: a build missing just that one var still deploys
normally and *preserves whatever mapsKey is already in the current config.js*
instead of blanking it — so a working Maps key never silently disappears just
because one build's environment didn't happen to pass it through.

Never commit service role keys or real API key values — only the committed
`config.js`'s empty placeholders are checked in; real values live in Netlify's
environment variables.

## Conventions

- Use `@/` path alias for imports from `src/`
- Add schema changes as new files in `supabase/migrations/`
- Regenerate `src/lib/database.types.ts` after migration changes
- Keep RLS policies on every table
- Prefer Supabase client calls from React; use Edge Functions only when you need secrets server-side

## Current scope

- Contacts CRUD (name, email, company, phone, notes)
- Dashboard with recent contacts
- Auth-ready schema (RLS requires authenticated users)

## Next features (suggested)

- Supabase Auth (email login)
- Deals / pipeline stages
- Activity log per contact
- Organizations and per-user data isolation
