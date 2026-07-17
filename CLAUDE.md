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

Copy `.env.example` to `.env.local` and set:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Never commit service role keys. Netlify gets the same `VITE_*` vars in Site settings → Environment variables.

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
