-- Fixes a real bug: invites never auto-accepted when the invited email's
-- case differed from the signup email (e.g. invite sent to "John@email.com",
-- John signs up with "john@email.com"). handle_new_user() (currently defined
-- in backend/supabase/schema-business-profile.sql) matched invites with an
-- exact `where email = new.email` comparison — no case-folding, no
-- whitespace trimming — so any casing difference silently fell through to
-- the "no matching invite" branch and the new user became their own new
-- business owner instead of joining the inviter's business. The invite then
-- sits with accepted_at still null forever, showing as permanently pending.
--
-- Also adds public.users.last_seen_at — genuine "last active in the app"
-- tracking (see index.html's pingLastSeen()) for the Team page's Active
-- now/Recently active/Offline status. auth.users.last_sign_in_at exists but
-- isn't reachable from the frontend and only reflects login time, not
-- current activity — this column measures the thing the UI actually needs
-- to show, updated by a heartbeat from the authenticated session itself.
--
-- Safe to re-run: idempotent throughout.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  inv record;
begin
  -- Case-insensitive, whitespace-trimmed match — the only change from the
  -- previous version of this function (schema-business-profile.sql). Emails
  -- are not case-sensitive per RFC 5321's common real-world treatment (and
  -- certainly not to the human who typed one differently in an invite vs a
  -- signup form), so this was always the correct comparison; it just wasn't
  -- written that way originally.
  select * into inv from public.invites
    where lower(trim(email)) = lower(trim(new.email)) and accepted_at is null
    order by created_at asc limit 1;

  if inv.id is not null then
    insert into public.users (id, business_id, email, role)
    values (new.id, inv.business_id, new.email, inv.role)
    on conflict (id) do nothing;
    update public.invites set accepted_at = now() where id = inv.id;
  else
    insert into public.users (id, business_id, email, role)
    values (new.id, new.id::text, new.email, 'owner')
    on conflict (id) do nothing;
    insert into public.businesses (id, name)
    values (new.id::text, null)
    on conflict (id) do nothing;
  end if;

  return new;
end;
$$;

-- ===== last_seen_at: real activity signal, not derived from login time =====
alter table public.users add column if not exists last_seen_at timestamptz;

-- Extends the existing self-update column grant (schema-team.sql) rather
-- than replacing it — name/phone remain self-updatable exactly as before,
-- last_seen_at is added to the same allow-list. The RLS policy itself
-- ("self update profile", id = auth.uid()) already covers this column;
-- only the column-level grant needs extending.
revoke update on public.users from authenticated;
grant update (name, phone, last_seen_at) on public.users to authenticated;
