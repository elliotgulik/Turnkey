# TurnKey CRM

TurnKey is a field-service CRM for pressure-washing businesses.

## Actual architecture

- The frontend is plain HTML, JavaScript and CSS, with no frontend build step.
- `index.html` is the staff workspace; `booking.html` and `quote.html` are public pages.
- Frontend modules, shared engines and styles live at the repository root.
- New UI goes in its own module, not `index.html`.
- `backend/` contains the Express backend and integrations that need secrets.
- Supabase provides Postgres, Auth, Storage and row-level security (RLS).
- `supabase/migrations/` is the source of truth for database schema changes.
- Netlify serves static assets. `scripts/build-static.js` prepares deployment
  assets; `scripts/generate-config.js` generates runtime configuration.

## Shared engines

- `pricing-engine.js` (`TK_PRICING`) owns customer-facing rates and totals.
  Public pages load it: never put internal cost or margin data in this engine.
- `cost-engine.js` (`TK_COST`) owns internal delivery costs and overheads.
  Prices include GST; margin calculations use revenue excluding GST.
- `sales-engine.js` (`TK_SALES`) owns funnel, source-return and sales statistics.
- Business pricing and cost settings persist in `businesses.pricing_config`.
- Lost quotes use `cancelled` plus `lostAt`/`lostReason`; use `isLost()` to
  distinguish them from won jobs cancelled later.

## Configuration and security

- Pages read `window.TURNKEY_CONFIG` from `config.js`.
- Runtime environment variables include `TURNKEY_BACKEND_URL`,
  `TURNKEY_SUPABASE_URL`, `TURNKEY_SUPABASE_ANON_KEY` and `TURNKEY_MAPS_KEY`.
- Keep real credentials in deployment environment variables, never in commits.
- Never expose service-role keys or backend secrets in frontend modules.
- Enable RLS and explicit tenant-aware policies on every new table.
- Add schema changes as new files in `supabase/migrations/`.
- Escape every interpolated value when inserting DB or user data into HTML,
  including attributes. Use local escaping helpers or `textContent`.
- Keep `TK_POLICIES.renderPolicyHtml` output as rendered policy HTML.

## Working conventions

- Preserve behavior outside the requested change; follow nearby module patterns.
- Do not read `index.html` or files over 400 lines whole; use scoped searches
  and at most 30 lines of context around relevant matches.
- Coordinate shared work and stage only files belonging to your task.
- For a local-only task, never push, open a PR, or change remote services.
- Frontend checks: `node --test tests/*.test.cjs`.
- Backend checks: `npm --prefix backend test`.
- Run the checks required by the task; report results and skipped checks.
