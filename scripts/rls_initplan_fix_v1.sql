begin;

-- Supabase's Performance Advisor (auth_rls_initplan, lint 0003) flags every RLS policy whose
-- USING/WITH CHECK expression calls auth.<fn>() or current_setting(...) directly — Postgres
-- re-evaluates that call once PER ROW instead of once per query. Supabase's documented fix is
-- mechanical and behavior-preserving: wrap the call in `(select ...)`, which the planner
-- caches as an InitPlan evaluated once. See:
-- https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select
--
-- This is written as a script that reads each flagged policy's REAL current definition
-- straight from pg_policies and rewrites only the matched auth.<fn>()/current_setting(...)
-- calls in place — not a hand-retyped copy of what old migration files show, which may be
-- stale versus what's actually live. Idempotent: running it again after it's already fixed
-- everything is a no-op (the regex no longer matches anything to replace).
do $$
declare
  pol record;
  new_using text;
  new_check text;
  changed boolean;
begin
  for pol in
    select
      schemaname,
      tablename,
      policyname,
      cmd,
      qual,
      with_check,
      roles
    from pg_policies
    where schemaname = 'public'
      and (
        qual ~ '(?<!\(select )\b(auth\.[a-z_]+\(\)|current_setting\([^)]*\))'
        or with_check ~ '(?<!\(select )\b(auth\.[a-z_]+\(\)|current_setting\([^)]*\))'
      )
  loop
    changed := false;
    new_using := pol.qual;
    new_check := pol.with_check;

    if new_using is not null then
      new_using := regexp_replace(new_using, '(?<!\(select )\b(auth\.[a-z_]+\(\))', '(select \1)', 'g');
      new_using := regexp_replace(new_using, '(?<!\(select )\b(current_setting\([^)]*\))', '(select \1)', 'g');
      if new_using is distinct from pol.qual then changed := true; end if;
    end if;

    if new_check is not null then
      new_check := regexp_replace(new_check, '(?<!\(select )\b(auth\.[a-z_]+\(\))', '(select \1)', 'g');
      new_check := regexp_replace(new_check, '(?<!\(select )\b(current_setting\([^)]*\))', '(select \1)', 'g');
      if new_check is distinct from pol.with_check then changed := true; end if;
    end if;

    if not changed then
      continue;
    end if;

    execute format(
      'alter policy %I on %I.%I %s %s',
      pol.policyname,
      pol.schemaname,
      pol.tablename,
      case when new_using is not null then format('using (%s)', new_using) else '' end,
      case when new_check is not null then format('with check (%s)', new_check) else '' end
    );

    raise notice 'Rewrote policy %.%.% to cache its auth/current_setting call(s).',
      pol.schemaname, pol.tablename, pol.policyname;
  end loop;
end $$;

commit;
