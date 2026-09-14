begin;

-- Security Advisor: function_search_path_mutable (lint 0011), WARN level. Pinning
-- search_path prevents a same-named object planted earlier in a manipulated search_path
-- from being resolved instead of the intended public.* one — it does not change these
-- functions' behavior for any call that already works today, since they're already written
-- assuming public-schema resolution. Safe, mechanical, no logic change.
--
-- Written to look up each function's real signature via pg_proc rather than hand-typing
-- argument types (resolve_provider_mapping in particular isn't defined in any tracked SQL
-- file in either repo — it was created directly in Studio at some point — so its exact
-- parameter types aren't something to guess at).
do $$
declare
  fn record;
  target_names text[] := array[
    'set_updated_at',
    'resolve_provider_mapping',
    'prevent_field_executive_dropx_id_change',
    'prevent_protected_role_delete',
    'set_company_allowed_domains_updated_at',
    'prevent_nonemployee_dropx_id_change',
    'ops_performance_review_clear_reopen_on_close'
  ];
begin
  for fn in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(target_names)
  loop
    execute format(
      'alter function public.%I(%s) set search_path = public, pg_temp',
      fn.proname,
      fn.args
    );
    raise notice 'Pinned search_path for public.%(%)', fn.proname, fn.args;
  end loop;
end $$;

-- Security Advisor: extension_in_public (lint 0014), WARN level. Supabase projects ship a
-- dedicated `extensions` schema for exactly this; moving btree_gist there doesn't change
-- how its operators are used (Supabase's default search_path already includes
-- `extensions`), just gets it out of `public` where anyone with public-schema create rights
-- could otherwise shadow it.
create schema if not exists extensions;
alter extension btree_gist set schema extensions;

commit;

-- NOT included here — needs your explicit review before changing, since either could break
-- a feature that depends on the current behavior:
--
-- 1. ERROR: public.hr_attendance_people_directory is a SECURITY DEFINER view — it runs with
--    the view creator's permissions rather than the querying user's, which can bypass RLS.
--    Changing it to SECURITY INVOKER (the fix) is only safe if the callers of this view are
--    NOT relying on it to see rows their own RLS policies would otherwise hide them from.
--
-- 2. WARN (many): a long list of SECURITY DEFINER functions callable via PostgREST RPC by
--    the completely unauthenticated `anon` role (attendance/capacity/worker-id-generation/
--    exit-case functions among them). Revoking EXECUTE from anon is only safe for functions
--    your own app never calls with the anon key (vs. a signed-in session) — need to check
--    each one against how apps/connect and the dashboard actually authenticate their calls
--    before revoking, or a legitimate anon-key call path could break.
