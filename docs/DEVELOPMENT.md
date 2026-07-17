# TurnKey development workflow

TurnKey is built across three AI assistants. They all work on the **same git repo** — the repo is the source of truth, not any single chat.

## Roles

| Tool | Best for |
|------|----------|
| **Cursor** | Day-to-day coding, refactors, debugging, running terminal commands in the IDE |
| **Claude Code** | Terminal-heavy work, migrations, multi-file changes from the shell, CI scripts |
| **ChatGPT** | Architecture reviews, product planning, second opinions, writing specs before you code |

## Shared context files

Keep these updated so every tool stays aligned:

- `CLAUDE.md` — project overview for Claude Code
- `.cursor/rules/turnkey.mdc` — conventions for Cursor Agent
- `docs/DEVELOPMENT.md` — this file (workflow + setup)
- `supabase/migrations/` — database truth
- `.env.example` — required environment variables (never commit real secrets)

## Recommended loop

1. **Plan in ChatGPT** — describe the feature, get a short spec (tables, routes, UI sketch).
2. **Implement in Cursor** — paste the spec into Agent chat; let Cursor edit the repo.
3. **Verify with Claude Code** — from the project root:
   ```bash
   cd ~/Projects/TurnKey
   claude
   ```
   Ask Claude Code to run migrations, fix test failures, or do bulk refactors.
4. **Commit** — one feature per commit; all three tools see the same history.

## First-time setup

### 1. Install prerequisites

```bash
# Node.js 20+ (via https://nodejs.org or nvm)
node --version

# Supabase CLI
brew install supabase/tap/supabase

# Netlify CLI (optional, for deploys from terminal)
npm install -g netlify-cli
```

### 2. Install dependencies

```bash
cd ~/Projects/TurnKey
npm install
cp .env.example .env.local
```

### 3. Create Supabase project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) → New project
2. Copy **Project URL** and **anon public** key into `.env.local`
3. Link and push schema:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

### 4. Run locally

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

For fully local Supabase (no cloud):

```bash
supabase start
# Use the local URL and anon key printed by supabase start
```

### 5. Deploy to Netlify

**Option A — Git-based (recommended)**

1. Push TurnKey to GitHub
2. [app.netlify.com](https://app.netlify.com) → Add new site → Import from Git
3. Build command: `npm run build`
4. Publish directory: `dist`
5. Add environment variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`

**Option B — CLI**

```bash
netlify login
netlify init
netlify deploy --prod
```

## Using ChatGPT as a dev assistant

ChatGPT does not edit this repo directly. Use it like a senior reviewer:

- Paste error messages + relevant file snippets
- Ask for schema design before writing migrations
- Ask it to critique a plan you got from Cursor or Claude Code
- Export its spec into a Cursor prompt: *"Implement this spec in TurnKey: …"*

Keep a `docs/specs/` folder (optional) for ChatGPT-generated feature briefs you are actively building.

## Using Claude Code

From the TurnKey root:

```bash
claude
```

Claude Code reads `CLAUDE.md` automatically. Example prompts:

- "Apply the latest migration and regenerate database types"
- "Add Supabase email auth with a login page"
- "Add a deals table with pipeline stages and RLS"

## Auth note

The current schema requires **authenticated** Supabase users for contact access. Until you add a login UI, you can temporarily add a dev policy or sign up via Supabase Auth dashboard. Next step: add email/password auth to the app.

## Security checklist

- [ ] `.env.local` is gitignored
- [ ] Only `VITE_*` keys in Netlify (anon key is fine — it is public by design)
- [ ] Service role key stays in Supabase dashboard / server-only contexts only
- [ ] RLS enabled on every table
