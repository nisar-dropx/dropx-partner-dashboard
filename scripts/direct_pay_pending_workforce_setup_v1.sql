begin;

-- Payment setup is allowed before a Workforce member completes app
-- registration. Pending/under-review/returned/approved onboarding profiles
-- are not operational payout profiles yet, but their direct-pay terms can be
-- prepared so activation does not leave an unpriced period. Terminal and
-- genuinely inactive profiles remain ineligible.
do $migration$
declare
  v_before text;
  v_after text;
  v_old_predicate text := E'\n    and workforce.is_active = true';
  v_new_predicate text := E'\n    and (\n      workforce.is_active = true\n      or (\n        lower(btrim(coalesce(workforce.onboarding_status, ''''))) in (\n          ''pending'',\n          ''under_review'',\n          ''returned'',\n          ''approved''\n        )\n        and lower(btrim(coalesce(workforce.lifecycle_status, ''''))) in (\n          '''',\n          ''onboarding'',\n          ''active''\n        )\n      )\n    )';
begin
  v_before := pg_get_functiondef(
    'public.save_workforce_payment_allocation(uuid,uuid,uuid,jsonb,date,date,text,uuid)'::regprocedure
  );
  v_after := replace(v_before, E'\r\n', E'\n');

  if position(v_old_predicate in v_after) > 0 then
    v_after := replace(v_after, v_old_predicate, v_new_predicate);
    v_after := replace(
      v_after,
      'Workforce member must be active, have an active company location and use a designation enabled for direct payment allocation.',
      'Workforce member must be active or awaiting registration, have an active company location and use a designation enabled for direct payment allocation.'
    );
    execute v_after;
  elsif position('Workforce member must be active or awaiting registration' in v_after) = 0
    or position('''pending''' in v_after) = 0 then
    raise exception 'Unable to enable direct-pay setup for pending Workforce profiles.';
  end if;
end
$migration$;

-- A pending registration is intentionally not operationally active yet. Do
-- not let an ordinary onboarding location/designation correction treat that
-- state as employment offboarding and cancel its prepared direct-pay terms.
do $transition$
declare
  v_before text;
  v_after text;
  v_old_predicate text := E'  v_offboarding := new.is_active = false\n    or new.deleted_at is not null\n    or new.deactivated_at is not null\n    or new.last_working_date is not null\n    or v_terminal_status;';
  v_new_predicate text := E'  v_offboarding := (\n    new.is_active = false\n    and not (\n      lower(btrim(coalesce(new.onboarding_status, ''''))) in (\n        ''pending'',\n        ''under_review'',\n        ''returned'',\n        ''approved''\n      )\n      and lower(btrim(coalesce(new.lifecycle_status, ''''))) in (\n        '''',\n        ''onboarding'',\n        ''active''\n      )\n    )\n  )\n    or new.deleted_at is not null\n    or new.deactivated_at is not null\n    or new.last_working_date is not null\n    or v_terminal_status;';
begin
  v_before := pg_get_functiondef(
    'public.reconcile_workforce_direct_payment_transition()'::regprocedure
  );
  v_after := replace(v_before, E'\r\n', E'\n');

  if position(v_old_predicate in v_after) > 0 then
    v_after := replace(v_after, v_old_predicate, v_new_predicate);
    execute v_after;
  elsif position('lower(btrim(coalesce(new.onboarding_status' in v_after) = 0 then
    raise exception 'Unable to preserve pending Workforce direct-pay allocations during onboarding edits.';
  end if;
end
$transition$;

comment on function public.save_workforce_payment_allocation(uuid, uuid, uuid, jsonb, date, date, text, uuid) is
  'Saves effective-dated direct-pay terms for active Workforce or non-terminal registration profiles; payouts remain governed by profile eligibility.';

comment on function public.reconcile_workforce_direct_payment_transition() is
  'Reconciles direct-pay ownership changes without treating valid pre-activation registration profiles as employment offboarding.';

notify pgrst, 'reload schema';

commit;
