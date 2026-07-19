-- TurnKey: business-specific pricing configuration (service rates, chemical
-- costs, labour/travel/margin inputs), persisted server-side. Previously
-- SERVICES.rate/CHEMICALS.perL only saved to localStorage (per-device, lost
-- on a new browser/device) and COST_INPUTS (wage, crew size, fuel, target
-- margin) was a hardcoded constant with no UI at all. Run once in the
-- Supabase SQL editor.
alter table public.businesses add column if not exists pricing_config jsonb;
