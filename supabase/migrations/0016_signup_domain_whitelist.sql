-- =============================================================================
-- Signup domain whitelist
--
-- Only company email addresses may create accounts. Enforcement lives here in
-- handle_new_user — raising inside the on_auth_user_created trigger rolls back
-- the auth.users insert, so a signup from any other domain fails even when the
-- Supabase Auth API is called directly. The signup form checks the same list
-- client-side (src/lib/signup.ts) to show a friendly message before Supabase
-- returns its generic "Database error saving new user"; keep the two lists in
-- lockstep.
-- =============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  existing int;
begin
  if lower(split_part(new.email, '@', 2)) not in
    ('superiormarineinc.com', 'stravisor.com', 'riverwalkoh.com')
  then
    raise exception 'Sign-ups are limited to approved company email domains.';
  end if;

  select count(*) into existing from public.profiles;
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    case when existing = 0 then 'admin'::public.app_role else 'estimator'::public.app_role end
  );
  return new;
end;
$$;
