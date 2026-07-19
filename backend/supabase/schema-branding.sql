-- TurnKey: business accent colour, persisted server-side (previously only
-- lived in docTemplate/localStorage, so it never synced across devices and
-- never reached the public booking page). Run once in the Supabase SQL editor.
alter table public.businesses add column if not exists accent_color text;
