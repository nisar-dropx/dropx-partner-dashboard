begin;

-- Manual and workbook payout edits share this RPC.  The legacy import stack
-- and source-table guards still treat approved/paid payroll periods as
-- immutable, even though the bank ledger now provides the narrower financial
-- interlock: Payment Processing.  Scope the legacy bypass to this RPC call and
-- restore the caller's transaction-local value before returning.  The bank
-- processing triggers do not consult this setting and therefore remain hard
-- stops for every source write.
do $patch_public_importer$
declare
  v_signature regprocedure :=
    'public.workforce_apply_payout_import(uuid,date,date,text,text,jsonb,uuid,uuid[])'::regprocedure;
  v_definition text;
  v_old text;
  v_new text;
  v_count integer;
begin
  select replace(pg_get_functiondef(v_signature), chr(13), '')
  into v_definition;

  v_old := '  v_latest record;';
  v_new := E'  v_latest record;\n  v_previous_trusted_edit text := pg_catalog.current_setting(\n    ''app.workforce_payout_nonprocessing_edit'',\n    true\n  );';
  v_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
    / length(v_old);
  if v_count <> 1 then
    raise exception 'Unexpected trusted-edit declaration marker in % (found %).',
      v_signature::text, v_count;
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := '  v_batch_id := public.workforce_apply_payout_import_without_publication_refresh(';
  v_new := E'  perform pg_catalog.set_config(\n    ''app.workforce_payout_nonprocessing_edit'',\n    ''workforce_apply_payout_import'',\n    true\n  );\n\n  v_batch_id := public.workforce_apply_payout_import_without_publication_refresh(';
  v_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
    / length(v_old);
  if v_count <> 1 then
    raise exception 'Unexpected trusted-edit entry marker in % (found %).',
      v_signature::text, v_count;
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  -- A terminal review decision remains terminal.  Its immutable snapshot gets
  -- a new audited revision below; the refresh writer intentionally performs a
  -- same-status review update, preserving the approval/cancellation decision.
  v_old := E'    if v_latest.review_status in (''approved'', ''cancelled'') then\n      raise exception ''Published payout inputs cannot be changed after its review is approved or cancelled.'';\n    end if;\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
    / length(v_old);
  if v_count <> 1 then
    raise exception 'Unexpected terminal-review import guard in % (found %).',
      v_signature::text, v_count;
  end if;
  v_definition := replace(v_definition, v_old, '');

  v_old := E'      company_id, input_batch_id, workforce_id, station_id,\n      period_start, period_end, base_publication_id, base_revision,';
  v_new := E'      company_id, input_batch_id, refresh_source, refresh_request_id,\n      workforce_id, station_id, period_start, period_end,\n      base_publication_id, base_revision,';
  v_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
    / length(v_old);
  if v_count <> 1 then
    raise exception 'Unexpected payout refresh queue column marker in % (found %).',
      v_signature::text, v_count;
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := E'      p_company_id, v_batch_id, v_target.workforce_id, v_target.station_id,\n      v_target.period_start, v_target.period_end, v_latest.id,';
  v_new := E'      p_company_id, v_batch_id, ''input_batch'', v_batch_id,\n      v_target.workforce_id, v_target.station_id,\n      v_target.period_start, v_target.period_end, v_latest.id,';
  v_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
    / length(v_old);
  if v_count <> 1 then
    raise exception 'Unexpected payout refresh queue value marker in % (found %).',
      v_signature::text, v_count;
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := E'    on conflict (\n      company_id, input_batch_id, workforce_id, station_id,\n      period_start, period_end\n    ) do nothing;';
  v_new := E'    on conflict on constraint workforce_payout_refresh_jobs_request_identity_unique\n    do nothing;';
  v_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
    / length(v_old);
  if v_count <> 1 then
    raise exception 'Unexpected payout refresh queue conflict target in % (found %).',
      v_signature::text, v_count;
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := '  return v_batch_id;';
  v_new := E'  perform pg_catalog.set_config(\n    ''app.workforce_payout_nonprocessing_edit'',\n    coalesce(v_previous_trusted_edit, ''''),\n    true\n  );\n  return v_batch_id;';
  v_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
    / length(v_old);
  if v_count <> 1 then
    raise exception 'Unexpected trusted-edit exit marker in % (found %).',
      v_signature::text, v_count;
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  execute v_definition;
end
$patch_public_importer$;

-- The retained layers each repeat the same historical approved/paid payroll
-- gate.  Patch the exact block in every layer; marker counts make deployment
-- fail closed if a production function has drifted from the reviewed shape.
do $patch_retained_importers$
declare
  v_signature regprocedure;
  v_signature_text text;
  v_definition text;
  v_old text;
  v_new text;
  v_base_old text := E'  if exists (\n    select 1\n    from public.workforce_payroll_runs payroll_run\n    where payroll_run.company_id = p_company_id\n      and lower(coalesce(payroll_run.status, '''')) in (''approved'', ''paid'')\n      and daterange(payroll_run.period_start, payroll_run.period_end, ''[]'')\n        && daterange(p_effective_from, p_effective_to, ''[]'')\n  ) then\n    raise exception ''The selected payout import period overlaps an approved or paid Workforce payroll.'';\n  end if;';
  v_base_new text := $replacement$  if pg_catalog.current_setting(
      'app.workforce_payout_nonprocessing_edit', true
    ) is distinct from 'workforce_apply_payout_import'
    and exists (
      select 1
      from public.workforce_payroll_runs payroll_run
      where payroll_run.company_id = p_company_id
        and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
        and daterange(payroll_run.period_start, payroll_run.period_end, '[]')
          && daterange(p_effective_from, p_effective_to, '[]')
    )
  then
    raise exception 'The selected payout import period overlaps an approved or paid Workforce payroll.';
  end if;$replacement$;
  v_count integer;
  v_signatures text[] := array[
    'public.workforce_apply_payout_import_without_deductions(uuid,date,date,text,text,jsonb,uuid,uuid[])',
    'public.workforce_apply_payout_import_without_attendance_values(uuid,date,date,text,text,jsonb,uuid,uuid[])',
    'public.workforce_apply_payout_import_without_publication_refresh(uuid,date,date,text,text,jsonb,uuid,uuid[])'
  ];
begin
  foreach v_signature_text in array v_signatures
  loop
    v_signature := to_regprocedure(v_signature_text);
    if v_signature is null then
      if v_signature_text like '%without_publication_refresh%' then
        raise exception 'Required retained payout importer % is unavailable.',
          v_signature_text;
      end if;
      continue;
    end if;
    v_old := v_base_old;
    v_new := v_base_new;
    if v_signature_text like '%without_attendance_values%' then
      -- The deduction wrapper's guard is nested in its deduction-row branch.
      v_old := '  ' || replace(v_base_old, E'\n', E'\n  ');
      v_new := '  ' || replace(v_base_new, E'\n', E'\n  ');
    end if;
    select replace(pg_get_functiondef(v_signature), chr(13), '')
    into v_definition;
    v_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
      / length(v_old);
    if v_count = 0
      and position(
        'The selected payout import period overlaps an approved or paid Workforce payroll.'
        in v_definition
      ) = 0
    then
      -- Compatibility with retained implementations from before the legacy
      -- payroll gate was introduced (and with reduced verification schemas).
      continue;
    end if;
    if v_count <> 1 then
      raise exception 'Unexpected approved/paid import guard in % (found %).',
        v_signature::text, v_count;
    end if;
    v_definition := replace(v_definition, v_old, v_new);
    execute v_definition;
  end loop;
end
$patch_retained_importers$;

-- Source-table triggers are defense in depth beneath the importer.  They may
-- bypass only their legacy approved/paid payroll check while the trusted RPC
-- marker is active.  Their Workforce/company locks and updated_at behavior are
-- retained, and the separate *_00_bank_processing_guard triggers are untouched.
do $patch_finalized_source_guard$
declare
  v_signature regprocedure :=
    to_regprocedure('public.guard_finalized_workforce_payout_input()');
  v_definition text;
  v_old text;
  v_new text;
  v_count integer;
begin
  if v_signature is null then
    return;
  end if;
  select replace(pg_get_functiondef(v_signature), chr(13), '')
  into v_definition;

  v_old := E'  if (v_old_company_id is not null and exists (\n      select 1 from public.workforce_payroll_runs payroll_run\n      where payroll_run.company_id = v_old_company_id\n        and lower(coalesce(payroll_run.status, '''')) in (''approved'', ''paid'')\n        and daterange(payroll_run.period_start, payroll_run.period_end, ''[]'')\n          && daterange(v_old_from, v_old_to, ''[]'')\n    )) or (v_new_company_id is not null and exists (\n      select 1 from public.workforce_payroll_runs payroll_run\n      where payroll_run.company_id = v_new_company_id\n        and lower(coalesce(payroll_run.status, '''')) in (''approved'', ''paid'')\n        and daterange(payroll_run.period_start, payroll_run.period_end, ''[]'')\n          && daterange(v_new_from, v_new_to, ''[]'')\n    )) then\n    raise exception ''Workforce payout input cannot change because the affected period is approved or paid.'';\n  end if;';
  v_new := $replacement$  if pg_catalog.current_setting(
      'app.workforce_payout_nonprocessing_edit', true
    ) is distinct from 'workforce_apply_payout_import'
    and (
      (v_old_company_id is not null and exists (
        select 1 from public.workforce_payroll_runs payroll_run
        where payroll_run.company_id = v_old_company_id
          and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
          and daterange(payroll_run.period_start, payroll_run.period_end, '[]')
            && daterange(v_old_from, v_old_to, '[]')
      ))
      or (v_new_company_id is not null and exists (
        select 1 from public.workforce_payroll_runs payroll_run
        where payroll_run.company_id = v_new_company_id
          and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
          and daterange(payroll_run.period_start, payroll_run.period_end, '[]')
            && daterange(v_new_from, v_new_to, '[]')
      ))
    )
  then
    raise exception 'Workforce payout input cannot change because the affected period is approved or paid.';
  end if;$replacement$;

  v_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
    / length(v_old);
  if v_count <> 1 then
    raise exception 'Unexpected finalized payout source guard in % (found %).',
      v_signature::text, v_count;
  end if;
  v_definition := replace(v_definition, v_old, v_new);
  execute v_definition;
end
$patch_finalized_source_guard$;

-- Additional-payment rows use a shared finalized-period predicate instead of
-- the general source guard.  Preserve its ordinary behavior and expose the
-- same narrowly-scoped trusted-import bypass.  Older compatible deployments
-- can lack this optional payout source, so patch it only when installed.
do $patch_additional_payment_guard$
declare
  v_signature regprocedure := to_regprocedure(
    'public.workforce_additional_payment_period_is_finalized(uuid,uuid,date,date)'
  );
  v_definition text;
  v_old text := '  select exists (';
  v_new text := E'  select pg_catalog.current_setting(\n      ''app.workforce_payout_nonprocessing_edit'', true\n    ) is distinct from ''workforce_apply_payout_import''\n    and exists (';
  v_count integer;
begin
  if v_signature is null then
    return;
  end if;
  select replace(pg_get_functiondef(v_signature), chr(13), '')
  into v_definition;
  v_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
    / length(v_old);
  if v_count <> 1 then
    raise exception 'Unexpected additional-payment finalized predicate in % (found %).',
      v_signature::text, v_count;
  end if;
  v_definition := replace(v_definition, v_old, v_new);
  execute v_definition;
end
$patch_additional_payment_guard$;

-- Approved/cancelled review status and decision metadata stay unchanged.  The
-- retained revision writer already uses a same-status SET for those states;
-- widen only its optimistic predicate so it can attach the recalculated
-- snapshot and create the next immutable publication revision.
do $patch_revision_writer$
declare
  v_signature regprocedure :=
    'public.workforce_apply_payout_publication_input_revisions_without_hardening(uuid,date,date,text,uuid,jsonb)'::regprocedure;
  v_definition text;
  v_old text := '      and review.status in (''under_review'', ''returned'')';
  v_new text := '      and review.status in (''under_review'', ''returned'', ''approved'', ''cancelled'')';
  v_count integer;
begin
  select replace(pg_get_functiondef(v_signature), chr(13), '')
  into v_definition;
  v_count := (length(v_definition) - length(replace(v_definition, v_old, '')))
    / length(v_old);
  if v_count <> 1 then
    raise exception 'Unexpected payout revision review predicate in % (found %).',
      v_signature::text, v_count;
  end if;
  v_definition := replace(v_definition, v_old, v_new);
  execute v_definition;
end
$patch_revision_writer$;

-- Reassert the intended API boundary after CREATE OR REPLACE/definition
-- replay.  Only service_role may enter the trusted wrapper; retained layers
-- remain inaccessible as standalone RPCs.
revoke all on function public.workforce_apply_payout_import(
  uuid, date, date, text, text, jsonb, uuid, uuid[]
) from public, anon, authenticated, service_role;
grant execute on function public.workforce_apply_payout_import(
  uuid, date, date, text, text, jsonb, uuid, uuid[]
) to service_role;

do $revoke_retained_importers$
declare
  v_signature regprocedure;
  v_signature_text text;
  v_signatures text[] := array[
    'public.workforce_apply_payout_import_without_deductions(uuid,date,date,text,text,jsonb,uuid,uuid[])',
    'public.workforce_apply_payout_import_without_attendance_values(uuid,date,date,text,text,jsonb,uuid,uuid[])',
    'public.workforce_apply_payout_import_without_publication_refresh(uuid,date,date,text,text,jsonb,uuid,uuid[])'
  ];
begin
  foreach v_signature_text in array v_signatures
  loop
    v_signature := to_regprocedure(v_signature_text);
    if v_signature is not null then
      execute format(
        'revoke all on function %s from public, anon, authenticated, service_role',
        v_signature::text
      );
    end if;
  end loop;
end
$revoke_retained_importers$;

comment on function public.workforce_apply_payout_import(
  uuid, date, date, text, text, jsonb, uuid, uuid[]
) is
  'Service-role payout input editor. Approved/paid and terminal-review payouts receive audited immutable revisions; Payment Processing and in-flight notification sends remain locked.';

notify pgrst, 'reload schema';

commit;
