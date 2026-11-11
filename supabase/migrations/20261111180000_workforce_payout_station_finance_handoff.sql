-- Workforce / Helper station confirmation → Finance handoff → bank gate.
-- Patterned on hr_payroll_station_releases + people_finance_*. Apply alone to the
-- shared Supabase project after app tests pass; do not blanket-push migrations.

begin;

create table if not exists public.workforce_payout_station_releases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  audience text not null check (audience in ('workforce', 'helpers')),
  period_start date not null,
  period_end date not null,
  station_id uuid not null references public.stations(id) on delete cascade,
  worksheet_hash text not null,
  row_count integer not null check (row_count >= 0),
  amount_paise bigint not null check (amount_paise >= 0),
  released_by uuid not null,
  released_at timestamptz not null default clock_timestamp(),
  constraint workforce_payout_station_releases_period_chk check (period_end >= period_start),
  constraint workforce_payout_station_releases_key unique (company_id, audience, period_start, period_end, station_id)
);

create index if not exists workforce_payout_station_releases_period_idx
  on public.workforce_payout_station_releases (company_id, audience, period_start, period_end);

create table if not exists public.workforce_payout_finance_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  audience text not null check (audience in ('workforce', 'helpers')),
  period_start date not null,
  period_end date not null,
  station_id uuid not null references public.stations(id) on delete cascade,
  status text not null check (status in ('submitted', 'approved', 'returned')),
  worksheet_hash text not null,
  row_count integer not null check (row_count >= 0),
  amount_paise bigint not null check (amount_paise >= 0),
  submitted_by uuid not null,
  submitted_at timestamptz not null default clock_timestamp(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text not null default '',
  version integer not null default 1 check (version >= 1),
  constraint workforce_payout_finance_requests_period_chk check (period_end >= period_start),
  constraint workforce_payout_finance_requests_key unique (company_id, audience, period_start, period_end, station_id)
);

create index if not exists workforce_payout_finance_requests_status_idx
  on public.workforce_payout_finance_requests (company_id, audience, period_start, period_end, status);

create table if not exists public.workforce_payout_finance_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.workforce_payout_finance_requests(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  actor_id uuid not null,
  action text not null,
  reason text not null default '',
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists workforce_payout_finance_events_request_idx
  on public.workforce_payout_finance_events (request_id, created_at desc, id);

create table if not exists public.workforce_payout_enquiry_imports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  actor_id uuid not null,
  operation_id uuid not null,
  file_sha256 text not null,
  file_name text not null,
  status text not null check (status in ('pending', 'processing', 'completed', 'failed')),
  total_rows integer not null check (total_rows >= 0),
  cursor_row integer not null default 0 check (cursor_row >= 0),
  updated_count integer not null default 0,
  already_count integer not null default 0,
  attention_count integer not null default 0,
  unmatched_count integer not null default 0,
  workforce_rows jsonb not null default '[]'::jsonb,
  helper_rows jsonb not null default '[]'::jsonb,
  row_diagnostics jsonb not null default '[]'::jsonb,
  error_text text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint workforce_payout_enquiry_imports_operation_key unique (company_id, operation_id)
);

create index if not exists workforce_payout_enquiry_imports_status_idx
  on public.workforce_payout_enquiry_imports (company_id, status, updated_at desc);

do $$
declare tab text;
begin
  foreach tab in array array[
    'workforce_payout_station_releases',
    'workforce_payout_finance_requests',
    'workforce_payout_finance_events',
    'workforce_payout_enquiry_imports'
  ] loop
    execute format('alter table public.%I enable row level security', tab);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', tab);
    execute format('grant select, insert, update, delete on public.%I to service_role', tab);
  end loop;
end $$;

create or replace function public.workforce_payout_station_worksheet_snapshot(
  p_company uuid,
  p_audience text,
  p_period_start date,
  p_period_end date,
  p_station uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  payload jsonb := '[]'::jsonb;
begin
  if p_audience not in ('workforce', 'helpers') then
    raise exception 'Choose Workforce or Helpers.';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'Choose a valid payout period.';
  end if;
  if not exists (select 1 from public.stations where id = p_station and company_id = p_company) then
    raise exception 'The payroll station does not belong to this company.';
  end if;

  if p_audience = 'workforce' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'subject', x.workforce_id,
      'station', x.station_id,
      'net', coalesce((x.snapshot #>> '{item,net_amount}')::numeric, (x.snapshot #>> '{item,netAmount}')::numeric, 0),
      'revision', x.revision,
      'dependency', x.dependency_hash
    ) order by x.workforce_id), '[]'::jsonb)
    into payload
    from (
      select distinct on (w.workforce_id) w.*
      from public.workforce_payout_publications w
      where w.company_id = p_company
        and w.station_id = p_station
        and w.period_start = p_period_start
        and w.period_end = p_period_end
        and w.publication_kind = 'worksheet'
      order by w.workforce_id, w.revision desc, w.published_at desc nulls last, w.id desc
    ) x;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'subject', x.helper_id,
      'station', x.station_id,
      'net', coalesce((x.snapshot #>> '{item,net_amount}')::numeric, (x.snapshot #>> '{item,netAmount}')::numeric, 0),
      'revision', x.revision,
      'dependency', x.payout_dependency_hash
    ) order by x.helper_id), '[]'::jsonb)
    into payload
    from (
      select distinct on (h.helper_id) h.*
      from public.helper_payout_publications h
      where h.company_id = p_company
        and h.station_id = p_station
        and h.period_start = p_period_start
        and h.period_end = p_period_end
      order by h.helper_id, h.revision desc, h.published_at desc nulls last, h.id desc
    ) x;
  end if;

  return payload;
end;
$$;

create or replace function public.workforce_payout_station_worksheet_digest(p_payload jsonb)
returns table(worksheet_hash text, row_count integer, amount_paise bigint)
language sql
immutable
as $$
  select
    md5(coalesce(p_payload, '[]'::jsonb)::text),
    coalesce(jsonb_array_length(p_payload), 0),
    coalesce((
      select sum(greatest(0, round(coalesce((row->>'net')::numeric, 0) * 100))::bigint)
      from jsonb_array_elements(coalesce(p_payload, '[]'::jsonb)) row
    ), 0::bigint);
$$;

create or replace function public.workforce_payout_station_bank_enquiry_recorded(
  p_company uuid,
  p_audience text,
  p_period_start date,
  p_period_end date,
  p_station uuid
) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_audience = 'helpers' then
    return exists (
      select 1
      from public.helper_payout_payment_items i
      where i.company_id = p_company
        and i.location_id_snapshot = p_station
        and i.period_start = p_period_start
        and i.period_end = p_period_end
        and (
          i.status in ('paid', 'partially_paid')
          or i.response_import_id is not null
          or coalesce(i.bank_response_status, '') <> ''
        )
    );
  end if;
  return exists (
    select 1
    from public.workforce_payout_payment_items i
    where i.company_id = p_company
      and i.location_id_snapshot = p_station
      and i.period_start = p_period_start
      and i.period_end = p_period_end
      and (
        i.status in ('paid', 'partially_paid')
        or i.response_import_id is not null
        or coalesce(i.bank_response_status, '') <> ''
      )
  );
end;
$$;

create or replace function public.workforce_payout_station_release_confirm(
  p_company uuid,
  p_actor uuid,
  p_audience text,
  p_period_start date,
  p_period_end date,
  p_station uuid,
  p_expected_hash text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  payload jsonb;
  digest record;
  release_row public.workforce_payout_station_releases;
begin
  perform public.payment_release_actor(p_company, p_actor, p_station);
  if p_period_start <> date_trunc('month', p_period_start)::date
     or p_period_end <> (p_period_start + interval '1 month - 1 day')::date then
    raise exception 'Only a complete calendar month can be confirmed for payment.';
  end if;
  payload := public.workforce_payout_station_worksheet_snapshot(p_company, p_audience, p_period_start, p_period_end, p_station);
  select * into digest from public.workforce_payout_station_worksheet_digest(payload);
  if digest.row_count <= 0 then
    raise exception 'Publish at least one payout for this station before confirming it.';
  end if;
  if p_expected_hash is not null and p_expected_hash <> '' and p_expected_hash is distinct from digest.worksheet_hash then
    raise exception 'The station worksheet changed. Refresh and confirm again.';
  end if;

  insert into public.workforce_payout_station_releases as r (
    company_id, audience, period_start, period_end, station_id,
    worksheet_hash, row_count, amount_paise, released_by
  ) values (
    p_company, p_audience, p_period_start, p_period_end, p_station,
    digest.worksheet_hash, digest.row_count, digest.amount_paise, p_actor
  )
  on conflict (company_id, audience, period_start, period_end, station_id) do update
    set worksheet_hash = excluded.worksheet_hash,
        row_count = excluded.row_count,
        amount_paise = excluded.amount_paise,
        released_by = excluded.released_by,
        released_at = clock_timestamp()
  returning * into release_row;

  return jsonb_build_object(
    'id', release_row.id,
    'stationId', release_row.station_id,
    'worksheetHash', release_row.worksheet_hash,
    'rowCount', release_row.row_count,
    'amountPaise', release_row.amount_paise,
    'releasedAt', release_row.released_at
  );
end;
$$;

create or replace function public.workforce_payout_station_release_reopen(
  p_company uuid,
  p_actor uuid,
  p_audience text,
  p_period_start date,
  p_period_end date,
  p_station uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.payment_release_actor(p_company, p_actor, p_station);
  if public.workforce_payout_station_bank_enquiry_recorded(p_company, p_audience, p_period_start, p_period_end, p_station) then
    raise exception 'A bank enquiry is already recorded for this station, so it stays confirmed.';
  end if;
  if exists (
    select 1 from public.workforce_payout_finance_requests r
    where r.company_id = p_company and r.audience = p_audience
      and r.period_start = p_period_start and r.period_end = p_period_end
      and r.station_id = p_station and r.status = 'approved'
  ) then
    update public.workforce_payout_finance_requests
      set status = 'returned',
          reviewed_by = p_actor,
          reviewed_at = clock_timestamp(),
          review_note = 'Station reopened before bank enquiry. Resubmit after confirmation.',
          version = version + 1
    where company_id = p_company and audience = p_audience
      and period_start = p_period_start and period_end = p_period_end
      and station_id = p_station and status = 'approved';
  end if;
  delete from public.workforce_payout_station_releases
  where company_id = p_company and audience = p_audience
    and period_start = p_period_start and period_end = p_period_end
    and station_id = p_station;
end;
$$;

create or replace function public.workforce_payout_finance_submit(
  p_company uuid,
  p_actor uuid,
  p_audience text,
  p_period_start date,
  p_period_end date,
  p_station uuid,
  p_expected_hash text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  payload jsonb;
  digest record;
  release_row public.workforce_payout_station_releases;
  request_id uuid;
  existing public.workforce_payout_finance_requests;
begin
  perform public.payment_release_actor(p_company, p_actor, p_station);
  select * into release_row
  from public.workforce_payout_station_releases
  where company_id = p_company and audience = p_audience
    and period_start = p_period_start and period_end = p_period_end
    and station_id = p_station
  for update;
  if release_row.id is null then
    raise exception 'Confirm this station before sending it to Finance.';
  end if;
  payload := public.workforce_payout_station_worksheet_snapshot(p_company, p_audience, p_period_start, p_period_end, p_station);
  select * into digest from public.workforce_payout_station_worksheet_digest(payload);
  if digest.worksheet_hash is distinct from release_row.worksheet_hash
     or digest.worksheet_hash is distinct from p_expected_hash then
    raise exception 'The station worksheet changed after confirmation. Confirm again, then resubmit.';
  end if;

  select * into existing
  from public.workforce_payout_finance_requests
  where company_id = p_company and audience = p_audience
    and period_start = p_period_start and period_end = p_period_end
    and station_id = p_station
  for update;
  if existing.id is not null
     and existing.worksheet_hash = digest.worksheet_hash
     and existing.status in ('submitted', 'approved') then
    return existing.id;
  end if;

  insert into public.workforce_payout_finance_requests as r (
    company_id, audience, period_start, period_end, station_id,
    status, worksheet_hash, row_count, amount_paise, submitted_by
  ) values (
    p_company, p_audience, p_period_start, p_period_end, p_station,
    'submitted', digest.worksheet_hash, digest.row_count, digest.amount_paise, p_actor
  )
  on conflict (company_id, audience, period_start, period_end, station_id) do update
    set status = 'submitted',
        worksheet_hash = excluded.worksheet_hash,
        row_count = excluded.row_count,
        amount_paise = excluded.amount_paise,
        submitted_by = excluded.submitted_by,
        submitted_at = clock_timestamp(),
        reviewed_by = null,
        reviewed_at = null,
        review_note = '',
        version = public.workforce_payout_finance_requests.version + 1
  returning id into request_id;

  insert into public.workforce_payout_finance_events(request_id, company_id, actor_id, action, reason, snapshot)
  values (
    request_id, p_company, p_actor, 'submitted', 'Payout station sent to Finance',
    jsonb_build_object('hash', digest.worksheet_hash, 'rows', digest.row_count, 'amountPaise', digest.amount_paise)
  );
  return request_id;
end;
$$;

create or replace function public.workforce_payout_finance_decide(
  p_company uuid,
  p_request uuid,
  p_actor uuid,
  p_version integer,
  p_action text,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_row public.workforce_payout_finance_requests;
  payload jsonb;
  digest record;
  month_text text;
begin
  select * into request_row
  from public.workforce_payout_finance_requests
  where company_id = p_company and id = p_request
  for update;
  if request_row.id is null then
    raise exception 'Finance submission was not found.';
  end if;
  perform public.payment_release_actor(p_company, p_actor, request_row.station_id);
  if request_row.version <> p_version or request_row.status <> 'submitted' then
    raise exception 'The submission changed. Refresh Finance payouts.';
  end if;
  if p_action not in ('approve', 'return') or length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'Record the Finance review decision and reason.';
  end if;
  if p_action = 'approve' then
    if request_row.submitted_by = p_actor then
      raise exception 'Finance approval must be completed by someone other than the submitter.';
    end if;
    payload := public.workforce_payout_station_worksheet_snapshot(
      p_company, request_row.audience, request_row.period_start, request_row.period_end, request_row.station_id
    );
    select * into digest from public.workforce_payout_station_worksheet_digest(payload);
    if digest.worksheet_hash is distinct from request_row.worksheet_hash then
      raise exception 'Payouts changed after submission. Send the revised station from Ops again.';
    end if;
    if not exists (
      select 1 from public.workforce_payout_station_releases r
      where r.company_id = p_company and r.audience = request_row.audience
        and r.period_start = request_row.period_start and r.period_end = request_row.period_end
        and r.station_id = request_row.station_id
        and r.worksheet_hash = request_row.worksheet_hash
    ) then
      raise exception 'Station confirmation is missing or stale. Confirm the station again before Finance approval.';
    end if;
    month_text := to_char(request_row.period_start, 'YYYY-MM');
    perform public.assert_loss_payment_release(p_company, request_row.station_id, month_text, request_row.audience);
  end if;

  update public.workforce_payout_finance_requests
    set status = case when p_action = 'approve' then 'approved' else 'returned' end,
        reviewed_by = p_actor,
        reviewed_at = clock_timestamp(),
        review_note = trim(p_reason),
        version = version + 1
  where id = request_row.id;

  insert into public.workforce_payout_finance_events(request_id, company_id, actor_id, action, reason, snapshot)
  values (
    request_row.id, p_company, p_actor, p_action, trim(p_reason),
    jsonb_build_object('worksheet_hash', request_row.worksheet_hash, 'version', request_row.version)
  );
end;
$$;

create or replace function public.assert_workforce_payout_station_finance_ready(
  p_company uuid,
  p_audience text,
  p_period_start date,
  p_period_end date,
  p_station uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_row public.workforce_payout_finance_requests;
  payload jsonb;
  digest record;
begin
  select * into request_row
  from public.workforce_payout_finance_requests
  where company_id = p_company and audience = p_audience
    and period_start = p_period_start and period_end = p_period_end
    and station_id = p_station;
  if request_row.id is null or request_row.status <> 'approved' then
    raise exception 'Finance must approve the confirmed station before generating its bank file.';
  end if;
  payload := public.workforce_payout_station_worksheet_snapshot(p_company, p_audience, p_period_start, p_period_end, p_station);
  select * into digest from public.workforce_payout_station_worksheet_digest(payload);
  if digest.worksheet_hash is distinct from request_row.worksheet_hash then
    raise exception 'Payouts changed after Finance approval. Resubmit the station for Finance review.';
  end if;
  if not exists (
    select 1 from public.workforce_payout_station_releases r
    where r.company_id = p_company and r.audience = p_audience
      and r.period_start = p_period_start and r.period_end = p_period_end
      and r.station_id = p_station
      and r.worksheet_hash = request_row.worksheet_hash
  ) then
    raise exception 'Station confirmation is missing or stale. Confirm and resubmit before bank download.';
  end if;
end;
$$;

create or replace function public.workforce_payout_enquiry_import_begin(
  p_company uuid,
  p_actor uuid,
  p_operation uuid,
  p_file_sha256 text,
  p_file_name text,
  p_workforce_rows jsonb,
  p_helper_rows jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.workforce_payout_enquiry_imports;
  total integer;
  import_row public.workforce_payout_enquiry_imports;
begin
  if p_operation is null then raise exception 'A valid enquiry operation ID is required.'; end if;
  if length(trim(coalesce(p_file_sha256, ''))) < 32 then raise exception 'A file identity hash is required.'; end if;
  select * into existing
  from public.workforce_payout_enquiry_imports
  where company_id = p_company and operation_id = p_operation
  for update;
  if existing.id is not null then
    if existing.file_sha256 is distinct from p_file_sha256 then
      raise exception 'This enquiry operation was already used for a different file.';
    end if;
    return jsonb_build_object(
      'id', existing.id,
      'status', existing.status,
      'totalRows', existing.total_rows,
      'cursorRow', existing.cursor_row,
      'updatedCount', existing.updated_count,
      'alreadyCount', existing.already_count,
      'attentionCount', existing.attention_count,
      'unmatchedCount', existing.unmatched_count,
      'error', existing.error_text
    );
  end if;

  total := coalesce(jsonb_array_length(p_workforce_rows), 0) + coalesce(jsonb_array_length(p_helper_rows), 0);
  insert into public.workforce_payout_enquiry_imports (
    company_id, actor_id, operation_id, file_sha256, file_name, status,
    total_rows, workforce_rows, helper_rows
  ) values (
    p_company, p_actor, p_operation, p_file_sha256, left(coalesce(p_file_name, 'enquiry.xlsx'), 240),
    case when total = 0 then 'completed' else 'pending' end,
    total, coalesce(p_workforce_rows, '[]'::jsonb), coalesce(p_helper_rows, '[]'::jsonb)
  ) returning * into import_row;

  return jsonb_build_object(
    'id', import_row.id,
    'status', import_row.status,
    'totalRows', import_row.total_rows,
    'cursorRow', import_row.cursor_row,
    'updatedCount', import_row.updated_count,
    'alreadyCount', import_row.already_count,
    'attentionCount', import_row.attention_count,
    'unmatchedCount', import_row.unmatched_count,
    'error', import_row.error_text
  );
end;
$$;

create or replace function public.workforce_payout_enquiry_import_process(
  p_company uuid,
  p_actor uuid,
  p_import uuid,
  p_limit integer default 20
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  import_row public.workforce_payout_enquiry_imports;
  batch_limit integer := greatest(1, least(coalesce(p_limit, 20), 20));
  combined jsonb;
  slice jsonb;
  workforce_slice jsonb := '[]'::jsonb;
  helper_slice jsonb := '[]'::jsonb;
  child_operation uuid;
  finalized jsonb;
  paid integer := 0;
  cancelled integer := 0;
  rejected integer := 0;
  unknown_count integer := 0;
  next_cursor integer;
begin
  select * into import_row
  from public.workforce_payout_enquiry_imports
  where company_id = p_company and id = p_import
  for update;
  if import_row.id is null then
    raise exception 'Enquiry import was not found.';
  end if;
  if import_row.actor_id is distinct from p_actor and not exists (
    select 1 from public.profiles p where p.id = p_actor and p.company_id = p_company and p.is_active
  ) then
    raise exception 'An active company user is required.';
  end if;
  if import_row.status = 'completed' then
    return jsonb_build_object(
      'id', import_row.id,
      'status', import_row.status,
      'totalRows', import_row.total_rows,
      'cursorRow', import_row.cursor_row,
      'updatedCount', import_row.updated_count,
      'alreadyCount', import_row.already_count,
      'attentionCount', import_row.attention_count,
      'unmatchedCount', import_row.unmatched_count,
      'error', import_row.error_text,
      'done', true
    );
  end if;

  combined := coalesce(import_row.workforce_rows, '[]'::jsonb) || coalesce(import_row.helper_rows, '[]'::jsonb);
  if import_row.cursor_row >= import_row.total_rows then
    update public.workforce_payout_enquiry_imports
      set status = 'completed', updated_at = clock_timestamp(), error_text = null
    where id = import_row.id;
    return jsonb_build_object(
      'id', import_row.id,
      'status', 'completed',
      'totalRows', import_row.total_rows,
      'cursorRow', import_row.cursor_row,
      'updatedCount', import_row.updated_count,
      'alreadyCount', import_row.already_count,
      'attentionCount', import_row.attention_count,
      'unmatchedCount', import_row.unmatched_count,
      'done', true
    );
  end if;

  slice := coalesce((
    select jsonb_agg(value)
    from (
      select value
      from jsonb_array_elements(combined) with ordinality as t(value, ord)
      where ord > import_row.cursor_row and ord <= import_row.cursor_row + batch_limit
    ) s
  ), '[]'::jsonb);

  select coalesce(jsonb_agg(value), '[]'::jsonb)
  into workforce_slice
  from jsonb_array_elements(slice) value
  where coalesce(value->>'audience', '') = 'workforce'
     or (value ? 'reference_no' and left(upper(coalesce(value->>'reference_no','')), 2) = 'WF');

  select coalesce(jsonb_agg(value), '[]'::jsonb)
  into helper_slice
  from jsonb_array_elements(slice) value
  where coalesce(value->>'audience', '') = 'helpers'
     or (value ? 'reference_no' and left(upper(coalesce(value->>'reference_no','')), 2) = 'HP');

  -- Child operation keeps the parent file identity while remaining replay-safe per batch.
  child_operation := md5(import_row.operation_id::text || ':' || import_row.cursor_row::text)::uuid;

  begin
    update public.workforce_payout_enquiry_imports
      set status = 'processing', updated_at = clock_timestamp(), error_text = null
    where id = import_row.id;

    finalized := public.finalize_owned_payout_payment_response(
      p_company_id := p_company,
      p_actor_user_id := p_actor,
      p_operation_id := child_operation,
      p_file_sha256 := md5(import_row.file_sha256 || ':batch:' || import_row.cursor_row::text)
        || md5(import_row.operation_id::text || ':' || import_row.cursor_row::text),
      p_file_name := import_row.file_name,
      p_workforce_rows := workforce_slice,
      p_helper_rows := helper_slice
    );

    paid := coalesce((finalized->>'paid')::integer, 0);
    cancelled := coalesce((finalized->>'cancelled')::integer, 0);
    rejected := coalesce((finalized->>'rejected')::integer, 0);
    unknown_count := coalesce((finalized->>'unknown')::integer, 0);
    next_cursor := least(import_row.total_rows, import_row.cursor_row + batch_limit);

    update public.workforce_payout_enquiry_imports
      set cursor_row = next_cursor,
          updated_count = updated_count + paid + cancelled,
          already_count = already_count + greatest(0, jsonb_array_length(slice) - paid - cancelled - rejected - unknown_count),
          attention_count = attention_count + rejected,
          unmatched_count = unmatched_count + unknown_count,
          status = case when next_cursor >= total_rows then 'completed' else 'processing' end,
          row_diagnostics = coalesce(row_diagnostics, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
            'from', import_row.cursor_row,
            'to', next_cursor,
            'result', finalized
          )),
          updated_at = clock_timestamp(),
          error_text = null
    where id = import_row.id
    returning * into import_row;

  exception when others then
    update public.workforce_payout_enquiry_imports
      set status = 'failed',
          error_text = left(sqlerrm, 500),
          updated_at = clock_timestamp()
    where id = import_row.id;
    raise;
  end;

  return jsonb_build_object(
    'id', import_row.id,
    'status', import_row.status,
    'totalRows', import_row.total_rows,
    'cursorRow', import_row.cursor_row,
    'updatedCount', import_row.updated_count,
    'alreadyCount', import_row.already_count,
    'attentionCount', import_row.attention_count,
    'unmatchedCount', import_row.unmatched_count,
    'error', import_row.error_text,
    'done', import_row.status = 'completed',
    'batch', finalized
  );
end;
$$;

revoke all on function public.workforce_payout_station_worksheet_snapshot(uuid, text, date, date, uuid) from public, anon, authenticated;
revoke all on function public.workforce_payout_station_worksheet_digest(jsonb) from public, anon, authenticated;
revoke all on function public.workforce_payout_station_bank_enquiry_recorded(uuid, text, date, date, uuid) from public, anon, authenticated;
revoke all on function public.workforce_payout_station_release_confirm(uuid, uuid, text, date, date, uuid, text) from public, anon, authenticated;
revoke all on function public.workforce_payout_station_release_reopen(uuid, uuid, text, date, date, uuid) from public, anon, authenticated;
revoke all on function public.workforce_payout_finance_submit(uuid, uuid, text, date, date, uuid, text) from public, anon, authenticated;
revoke all on function public.workforce_payout_finance_decide(uuid, uuid, uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.assert_workforce_payout_station_finance_ready(uuid, text, date, date, uuid) from public, anon, authenticated;
revoke all on function public.workforce_payout_enquiry_import_begin(uuid, uuid, uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.workforce_payout_enquiry_import_process(uuid, uuid, uuid, integer) from public, anon, authenticated;

grant execute on function public.workforce_payout_station_worksheet_snapshot(uuid, text, date, date, uuid) to service_role;
grant execute on function public.workforce_payout_station_worksheet_digest(jsonb) to service_role;
grant execute on function public.workforce_payout_station_bank_enquiry_recorded(uuid, text, date, date, uuid) to service_role;
grant execute on function public.workforce_payout_station_release_confirm(uuid, uuid, text, date, date, uuid, text) to service_role;
grant execute on function public.workforce_payout_station_release_reopen(uuid, uuid, text, date, date, uuid) to service_role;
grant execute on function public.workforce_payout_finance_submit(uuid, uuid, text, date, date, uuid, text) to service_role;
grant execute on function public.workforce_payout_finance_decide(uuid, uuid, uuid, integer, text, text) to service_role;
grant execute on function public.assert_workforce_payout_station_finance_ready(uuid, text, date, date, uuid) to service_role;
grant execute on function public.workforce_payout_enquiry_import_begin(uuid, uuid, uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function public.workforce_payout_enquiry_import_process(uuid, uuid, uuid, integer) to service_role;

commit;
