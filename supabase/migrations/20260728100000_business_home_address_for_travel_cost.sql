-- Fixes a real cost-estimate bug: travel cost in every quote was computed
-- from a hardcoded constant (cost-engine.js's COST_INPUTS.avgKm, a fixed
-- 14km guess) regardless of how far the actual job address is from the
-- business — so travel cost (and therefore total cost, recommended price,
-- and margin) was wrong for every job that wasn't coincidentally ~14km
-- away. The existing `businesses.region`/`region_lat`/`region_lng`
-- columns (schema-business-profile.sql) aren't precise enough to fix this
-- — region is a free-text area like "Auckland, New Zealand" used for
-- weather, not a real depot/home-base address a distance calculation can
-- start from.
--
-- Adds a genuine home/depot address, geocoded on save the same way region
-- already is (see saveBusinessProfile() in index.html), used as the origin
-- for a real distance calculation (Google Distance Matrix if configured,
-- else geocode + straight-line fallback — see calcTravelDistance()).
--
-- Safe to re-run: idempotent.

alter table public.businesses add column if not exists home_address text;
alter table public.businesses add column if not exists home_lat double precision;
alter table public.businesses add column if not exists home_lng double precision;
