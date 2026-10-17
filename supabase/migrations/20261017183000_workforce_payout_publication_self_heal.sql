begin;

-- The worksheet can detect an immutable publication whose net amount no
-- longer matches the current, stable calculation.  Older dependency writers
-- did not always leave a queue row for that condition, so the regular worker
-- had nothing to claim and the UI could remain "Publication refresh pending"
-- indefinitely.  This service-only boundary repairs only the exact rows that
-- the server has just recalculated; it never trusts a browser-supplied amount.
create or replace function public.workforce_ensure_payout_publication_refresh_jobs(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_period_start date,
  p_period_end date,
  p_dependency_hash text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_row jsonb;
  v_workforce_id uuid;
  v_station_id uuid;
  v_current_target numeric;
  v_target_cents bigint;
  v_latest record;
  v_request_id uuid;
  v_inserted integer;
  v_open_jobs integer;
  v_failed_jobs integer;
  v_conflict_status text;
  v_requested integer := 0;
  v_enqueued integer := 0;
  v_already_queued integer := 0;
  v_failed integer := 0;
  v_current integer := 0;
  v_missing_publication integer := 0;
  v_mapping_unlocked integer := 0;
begin
  if p_company_id is null then
    raise exception 'Company is required to repair payout publications.';
  end if;
  if p_period_start is null
    or p_period_end is null
    or p_period_start <> date_trunc('month', p_period_start)::date
    or p_period_end <> (p_period_start + interval '1 month - 1 day')::date
  then
    raise exception 'Publication self-healing requires one complete calendar month.';
  end if;
  if p_dependency_hash is null
    or btrim(p_dependency_hash) !~* '^[0-9a-f]{32}$'
  then
    raise exception 'A valid payout dependency hash is required.';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Select between 1 and 10000 exact payout rows.';
  end if;
  if jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 10000 then
    raise exception 'Select between 1 and 10000 exact payout rows.';
  end if;

  -- Require the complete, deliberately small wire shape before casting any
  -- caller value.  In particular, no client-provided publication or queue
  -- identifier can influence the repair generation.
  if exists (
    select 1
    from jsonb_array_elements(p_rows) selected(value)
    where jsonb_typeof(selected.value) <> 'object'
  ) then
    raise exception 'Every payout row must be a JSON object.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) selected(value)
    where not selected.value ?& array[
        'workforce_id', 'station_id', 'current_target_amount'
      ]
      or (
        select count(*)
        from jsonb_object_keys(selected.value)
      ) <> 3
      or coalesce(selected.value ->> 'workforce_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(selected.value ->> 'station_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(selected.value -> 'current_target_amount') <> 'number'
  ) then
    raise exception 'Every payout row must contain only a valid Workforce ID, location ID, and paise-exact current target amount.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) selected(value)
    where (selected.value ->> 'current_target_amount')::numeric
        not between -999999999999.99 and 999999999999.99
      or round((selected.value ->> 'current_target_amount')::numeric, 2)
        <> (selected.value ->> 'current_target_amount')::numeric
  ) then
    raise exception 'Every payout row must contain only a valid Workforce ID, location ID, and paise-exact current target amount.';
  end if;

  if (
    select count(*)
    from jsonb_array_elements(p_rows)
  ) <> (
    select count(distinct (
      lower(selected.value ->> 'workforce_id') || '|' ||
      lower(selected.value ->> 'station_id')
    ))
    from jsonb_array_elements(p_rows) selected(value)
  ) then
    raise exception 'Each Workforce and location payout row must be unique.';
  end if;

  v_requested := jsonb_array_length(p_rows);

  for v_row in
    select selected.value
    from jsonb_array_elements(p_rows) selected(value)
    order by
      lower(selected.value ->> 'workforce_id'),
      lower(selected.value ->> 'station_id')
  loop
    v_workforce_id := (v_row ->> 'workforce_id')::uuid;
    v_station_id := (v_row ->> 'station_id')::uuid;
    v_current_target := round((v_row ->> 'current_target_amount')::numeric, 2);
    v_target_cents := round(v_current_target * 100)::bigint;

    select
      publication.id,
      publication.revision,
      publication.published_by,
      case
        when coalesce(publication.snapshot #>> '{item,net_amount}', '')
          ~ '^[+-]?[0-9]+([.][0-9]+)?$'
        then round((publication.snapshot #>> '{item,net_amount}')::numeric, 2)
        else null::numeric
      end as target_amount
    into v_latest
    from public.workforce_payout_publications publication
    where publication.company_id = p_company_id
      and publication.publication_kind = 'worksheet'
      and publication.workforce_id = v_workforce_id
      and publication.station_id = v_station_id
      and publication.period_start = p_period_start
      and publication.period_end = p_period_end
    order by publication.revision desc, publication.published_at desc, publication.id desc
    limit 1;

    if not found or v_latest.target_amount is null then
      v_missing_publication := v_missing_publication + 1;
      continue;
    end if;

    -- A mapping relock is the authority for the station set.  Never publish a
    -- dependency revision while that station set is intentionally unlocked.
    if exists (
      select 1
      from public.workforce_payout_mapping_revision_state(
        p_company_id, v_workforce_id
      ) revision
      where revision.period_start = p_period_start
        and revision.period_end = p_period_end
        and revision.revision_pending
    ) then
      v_mapping_unlocked := v_mapping_unlocked + 1;
      continue;
    end if;

    select
      count(*) filter (where job.status in ('pending', 'processing')),
      count(*) filter (where job.status = 'failed')
    into v_open_jobs, v_failed_jobs
    from public.workforce_payout_publication_refresh_jobs job
    where job.company_id = p_company_id
      and job.workforce_id = v_workforce_id
      and job.station_id = v_station_id
      and job.period_start = p_period_start
      and job.period_end = p_period_end;

    -- Prefer an active retry generation over an older dead letter.  Its
    -- successful immutable revision reconciles the covered failed jobs.
    if v_open_jobs > 0 then
      v_already_queued := v_already_queued + 1;
      continue;
    end if;
    if v_failed_jobs > 0 then
      v_failed := v_failed + 1;
      continue;
    end if;

    if round(v_latest.target_amount * 100)::bigint = v_target_cents then
      v_current := v_current + 1;
      continue;
    end if;

    -- The source publication, stable dependency generation, and calculated
    -- paise determine one reproducible repair request.  Concurrent callers
    -- therefore converge on one queue row without dropping location identity.
    v_request_id := md5(
      'workforce_payout_publication_self_heal:' ||
      v_latest.id::text || ':' || lower(btrim(p_dependency_hash)) || ':' ||
      v_target_cents::text
    )::uuid;

    insert into public.workforce_payout_publication_refresh_jobs (
      company_id,
      input_batch_id,
      refresh_source,
      refresh_request_id,
      workforce_id,
      station_id,
      period_start,
      period_end,
      base_publication_id,
      base_revision,
      requested_by,
      next_attempt_at
    ) values (
      p_company_id,
      null,
      'payout_dependency',
      v_request_id,
      v_workforce_id,
      v_station_id,
      p_period_start,
      p_period_end,
      v_latest.id,
      v_latest.revision,
      coalesce(p_actor_user_id, v_latest.published_by),
      clock_timestamp()
    )
    on conflict (
      company_id, refresh_request_id, workforce_id, station_id,
      period_start, period_end
    ) do nothing;

    get diagnostics v_inserted = row_count;
    if v_inserted = 1 then
      v_enqueued := v_enqueued + 1;
      continue;
    end if;

    select job.status
    into v_conflict_status
    from public.workforce_payout_publication_refresh_jobs job
    where job.company_id = p_company_id
      and job.refresh_request_id = v_request_id
      and job.workforce_id = v_workforce_id
      and job.station_id = v_station_id
      and job.period_start = p_period_start
      and job.period_end = p_period_end;

    if v_conflict_status = 'failed' then
      v_failed := v_failed + 1;
    else
      -- A concurrent completed generation has already produced (or is about
      -- to expose) the replacement publication, so treating it as queued lets
      -- the caller perform its normal exact-row verification pass.
      v_already_queued := v_already_queued + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'requested', v_requested,
    'enqueued', v_enqueued,
    'already_queued', v_already_queued,
    'failed', v_failed,
    'current', v_current,
    'missing_publication', v_missing_publication,
    'mapping_unlocked', v_mapping_unlocked
  );
end
$function$;

comment on function public.workforce_ensure_payout_publication_refresh_jobs(
  uuid, uuid, date, date, text, jsonb
) is
  'Idempotently repairs missing exact-row dependency refresh work after a stable server-side Workforce payout recalculation.';

revoke all on function public.workforce_ensure_payout_publication_refresh_jobs(
  uuid, uuid, date, date, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.workforce_ensure_payout_publication_refresh_jobs(
  uuid, uuid, date, date, text, jsonb
) to service_role;

notify pgrst, 'reload schema';

commit;
