-- Add the public-safe booking lookup before restricting legacy raw reads.
create schema if not exists turnkey_private;
revoke all on schema turnkey_private from public;
grant usage on schema turnkey_private to anon, authenticated, service_role;
create or replace function turnkey_private.get_public_business(p_business_id text)
returns jsonb language sql stable security definer set search_path=pg_catalog,public
as $function$
  select jsonb_build_object('name',name,'phone',phone,'email',email,'region',region,
    'logo_url',logo_url,'accent_color',accent_color,'primary_color',primary_color,
    'font_style',font_style,'policies_config',policies_config,
    'rates',pricing_config->'rates')
  from public.businesses where id=p_business_id;
$function$;
revoke all on function turnkey_private.get_public_business(text) from public, anon, authenticated;
grant execute on function turnkey_private.get_public_business(text) to anon, authenticated, service_role;
create or replace function public.get_public_business(p_business_id text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public
as $function$ select turnkey_private.get_public_business(p_business_id); $function$;
revoke all on function public.get_public_business(text) from public, anon, authenticated;
grant execute on function public.get_public_business(text) to anon, authenticated, service_role;
