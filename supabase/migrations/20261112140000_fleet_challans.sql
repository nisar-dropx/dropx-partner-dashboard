-- Fleet Challans: outstanding e-challans, Drive evidence refs, bridge into NL/SLP recovery.
-- Apply alone to shared Supabase. Portal sync stays app-gated until an authorized provider is configured.

begin;

create table if not exists public.fleet_challans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  vehicle_id uuid not null references public.fleet_vehicles(id) on delete restrict,
  vehicle_no text not null,
  station_code text not null,
  state_code text not null default '',
  challan_number text not null,
  offense_at timestamptz,
  offense_date date,
  offense_description text not null default '',
  issuing_authority text not null default 'unknown'
    check (issuing_authority in ('mvd','traffic_police','virtual_court','parivahan','other','unknown')),
  amount numeric(12,2) not null check (amount >= 0 and amount <= 10000000),
  status text not null default 'pending_review'
    check (status in (
      'pending_review','disputed','approved_for_recovery','recovering','recovered','disposed','cancelled','paid_external'
    )),
  source text not null default 'manual'
    check (source in ('manual','ingest','portal_sync')),
  evidence_url text,
  drive_file_id text,
  drive_view_url text,
  drive_mime_type text,
  raw_payload jsonb not null default '{}'::jsonb,
  responsible_note text not null default '',
  recovery_month text,
  recovery_case_key text,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, challan_number)
);

create index if not exists fleet_challans_queue_idx
  on public.fleet_challans(company_id, status, offense_date desc nulls last, created_at desc);
create index if not exists fleet_challans_vehicle_idx
  on public.fleet_challans(company_id, vehicle_id, status);
create index if not exists fleet_challans_station_idx
  on public.fleet_challans(company_id, station_code, status);

create table if not exists public.fleet_challan_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  challan_id uuid not null references public.fleet_challans(id) on delete cascade,
  action text not null,
  from_status text,
  to_status text,
  actor_id uuid references public.profiles(id),
  actor_name text not null default 'Fleet user',
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists fleet_challan_events_lookup
  on public.fleet_challan_events(company_id, challan_id, created_at desc);

create table if not exists public.fleet_challan_sync_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running','succeeded','failed','skipped')),
  vehicles_checked integer not null default 0,
  challans_upserted integer not null default 0,
  error_message text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists fleet_challan_sync_runs_company_idx
  on public.fleet_challan_sync_runs(company_id, started_at desc);

alter table public.fleet_challans enable row level security;
alter table public.fleet_challan_events enable row level security;
alter table public.fleet_challan_sync_runs enable row level security;
revoke all on public.fleet_challans, public.fleet_challan_events, public.fleet_challan_sync_runs from public, anon, authenticated;
grant select, insert, update on public.fleet_challans to service_role;
grant select, insert on public.fleet_challan_events to service_role;
grant select, insert, update on public.fleet_challan_sync_runs to service_role;

create or replace function public.fleet_challan_upsert_v1(p_company uuid, p_user uuid, p_data jsonb)
returns public.fleet_challans
language plpgsql
security invoker
set search_path = public
as $$
declare
  v public.fleet_vehicles%rowtype;
  challan_no text := upper(btrim(coalesce(p_data->>'challanNumber','')));
  v_vehicle_no text := upper(regexp_replace(coalesce(p_data->>'vehicleNo',''), '\s+', '', 'g'));
  v_amount numeric := nullif(p_data->>'amount','')::numeric;
  v_offense_date date := nullif(p_data->>'offenseDate','')::date;
  v_offense_at timestamptz := nullif(p_data->>'offenseAt','')::timestamptz;
  saved public.fleet_challans;
  previous public.fleet_challans;
  v_source text := coalesce(nullif(btrim(p_data->>'source'),''), 'manual');
begin
  if challan_no is null or length(challan_no) < 4 or length(challan_no) > 64 then
    raise exception 'Enter a valid challan number.';
  end if;
  if v_vehicle_no is null or length(v_vehicle_no) < 4 then
    raise exception 'Vehicle number is required.';
  end if;
  if v_amount is null or v_amount < 0 or v_amount > 10000000 then
    raise exception 'Enter a challan amount between ₹0 and ₹1,00,00,000.';
  end if;
  if v_source not in ('manual','ingest','portal_sync') then
    raise exception 'Invalid challan source.';
  end if;

  select * into v
  from public.fleet_vehicles fv
  where fv.company_id = p_company
    and upper(regexp_replace(fv.vehicle_no, '\s+', '', 'g')) = v_vehicle_no
  limit 1;
  if not found then raise exception 'Vehicle % was not found in Fleet.', v_vehicle_no; end if;
  if lower(coalesce(nullif(btrim(v.ownership_type),''),'own')) <> 'own' then
    raise exception 'Challans can only be recorded for DropX-owned vehicles.';
  end if;

  select * into previous
  from public.fleet_challans
  where company_id = p_company and challan_number = challan_no
  for update;

  if found then
    update public.fleet_challans set
      vehicle_id = v.id,
      vehicle_no = upper(v.vehicle_no),
      station_code = upper(v.station_code),
      state_code = coalesce(nullif(btrim(p_data->>'stateCode'),''), state_code),
      offense_at = coalesce(v_offense_at, previous.offense_at),
      offense_date = coalesce(
        v_offense_date,
        case when v_offense_at is not null then (v_offense_at at time zone 'Asia/Kolkata')::date else previous.offense_date end
      ),
      offense_description = case when coalesce(nullif(btrim(p_data->>'offenseDescription'),''),'') = '' then offense_description else btrim(p_data->>'offenseDescription') end,
      issuing_authority = case
        when coalesce(p_data->>'issuingAuthority','') in ('mvd','traffic_police','virtual_court','parivahan','other','unknown')
          then p_data->>'issuingAuthority'
        else issuing_authority
      end,
      amount = v_amount,
      evidence_url = coalesce(nullif(btrim(p_data->>'evidenceUrl'),''), evidence_url),
      drive_file_id = coalesce(nullif(btrim(p_data->>'driveFileId'),''), drive_file_id),
      drive_view_url = coalesce(nullif(btrim(p_data->>'driveViewUrl'),''), drive_view_url),
      drive_mime_type = coalesce(nullif(btrim(p_data->>'driveMimeType'),''), drive_mime_type),
      raw_payload = case when p_data ? 'rawPayload' then coalesce(p_data->'rawPayload','{}'::jsonb) else raw_payload end,
      status = case
        when status in ('pending_review','disputed') and coalesce(p_data->>'portalStatus','') in ('paid','disposed') then 'disposed'
        when status in ('pending_review','disputed') and coalesce(p_data->>'portalStatus','') = 'paid_external' then 'paid_external'
        else status
      end,
      updated_at = now()
    where id = previous.id
    returning * into saved;

    insert into public.fleet_challan_events(company_id, challan_id, action, from_status, to_status, actor_id, actor_name, note, metadata)
    values (
      p_company, saved.id, 'upsert', previous.status, saved.status, p_user, coalesce(nullif(btrim(p_data->>'actorName'),''),'Fleet user'),
      'Challan refreshed',
      jsonb_build_object('source', v_source)
    );
    return saved;
  end if;

  insert into public.fleet_challans(
    company_id, vehicle_id, vehicle_no, station_code, state_code, challan_number,
    offense_at, offense_date, offense_description, issuing_authority, amount, status, source,
    evidence_url, drive_file_id, drive_view_url, drive_mime_type, raw_payload, created_by
  ) values (
    p_company,
    v.id,
    upper(v.vehicle_no),
    upper(v.station_code),
    coalesce(nullif(btrim(p_data->>'stateCode'),''), left(upper(v.vehicle_no), 2)),
    challan_no,
    v_offense_at,
    coalesce(v_offense_date, case when v_offense_at is not null then (v_offense_at at time zone 'Asia/Kolkata')::date else null end),
    coalesce(nullif(btrim(p_data->>'offenseDescription'),''), 'Traffic challan'),
    case when coalesce(p_data->>'issuingAuthority','') in ('mvd','traffic_police','virtual_court','parivahan','other','unknown')
      then p_data->>'issuingAuthority' else 'unknown' end,
    v_amount,
    'pending_review',
    v_source,
    nullif(btrim(coalesce(p_data->>'evidenceUrl','')),''),
    nullif(btrim(coalesce(p_data->>'driveFileId','')),''),
    nullif(btrim(coalesce(p_data->>'driveViewUrl','')),''),
    nullif(btrim(coalesce(p_data->>'driveMimeType','')),''),
    coalesce(p_data->'rawPayload','{}'::jsonb),
    p_user
  ) returning * into saved;

  insert into public.fleet_challan_events(company_id, challan_id, action, from_status, to_status, actor_id, actor_name, note, metadata)
  values (p_company, saved.id, 'create', null, saved.status, p_user, coalesce(nullif(btrim(p_data->>'actorName'),''),'Fleet user'), 'Challan recorded', jsonb_build_object('source', v_source));
  return saved;
end;
$$;

create or replace function public.fleet_challan_set_status_v1(
  p_company uuid, p_challan uuid, p_user uuid, p_name text, p_status text, p_note text default null
) returns public.fleet_challans
language plpgsql
security invoker
set search_path = public
as $$
declare
  c public.fleet_challans;
  saved public.fleet_challans;
  note text := nullif(btrim(coalesce(p_note,'')),'');
begin
  if p_status not in ('pending_review','disputed','approved_for_recovery','recovering','recovered','disposed','cancelled','paid_external') then
    raise exception 'Choose a valid challan status.';
  end if;
  select * into c from public.fleet_challans where company_id = p_company and id = p_challan for update;
  if not found then raise exception 'Challan was not found.'; end if;
  if c.status = p_status then return c; end if;
  if note is not null and length(note) > 2000 then raise exception 'Keep the note under 2,000 characters.'; end if;

  update public.fleet_challans set
    status = p_status,
    responsible_note = case when note is null then responsible_note else note end,
    reviewed_by = p_user,
    reviewed_at = now(),
    updated_at = now()
  where id = c.id
  returning * into saved;

  insert into public.fleet_challan_events(company_id, challan_id, action, from_status, to_status, actor_id, actor_name, note)
  values (p_company, c.id, 'status', c.status, p_status, p_user, coalesce(nullif(btrim(p_name),''),'Fleet user'), note);
  return saved;
end;
$$;

-- Opens a Team Ops station-style loss case so existing NL/SLP recovery + payroll due logic applies.
create or replace function public.fleet_challan_open_recovery_v1(
  p_company uuid, p_challan uuid, p_user uuid, p_name text, p_note text default null
) returns public.fleet_challans
language plpgsql
security invoker
set search_path = public
as $$
declare
  c public.fleet_challans;
  saved public.fleet_challans;
  v_month text;
  v_key text;
  note text := nullif(btrim(coalesce(p_note,'')),'');
begin
  select * into c from public.fleet_challans where company_id = p_company and id = p_challan for update;
  if not found then raise exception 'Challan was not found.'; end if;
  if c.amount <= 0 then raise exception 'Challan amount must be greater than zero before recovery.'; end if;
  if c.status in ('cancelled','disposed','paid_external','recovered') then
    raise exception 'This challan is %, so recovery cannot be opened.', c.status;
  end if;

  v_month := to_char(coalesce(c.offense_date, (timezone('Asia/Kolkata', now()))::date), 'YYYY-MM');
  v_key := 'challan:' || c.challan_number;

  insert into public.nl_loss_month_cases(
    company_id, report, month, case_key, station_code, amount, source_status, details, source_present, source_file
  ) values (
    p_company,
    'station',
    v_month,
    v_key,
    c.station_code,
    c.amount,
    'Approved',
    jsonb_build_object(
      'tid', c.challan_number,
      'category', 'Fleet challan',
      'remarks', coalesce(nullif(c.offense_description,''), 'Traffic challan') || case when note is null then '' else E'\n' || note end,
      'impact_date', coalesce(c.offense_date, (timezone('Asia/Kolkata', now()))::date),
      'da_name', c.responsible_note,
      'challan_id', c.id,
      'vehicle_no', c.vehicle_no,
      'evidence_url', coalesce(c.drive_view_url, c.evidence_url),
      'approved_by', coalesce(nullif(btrim(p_name),''),'Fleet user'),
      'issuing_authority', c.issuing_authority
    ),
    true,
    'fleet-challan'
  )
  on conflict (company_id, month, case_key) do update
    set amount = excluded.amount,
        source_status = 'Approved',
        source_present = true,
        details = excluded.details,
        last_seen_at = now();

  update public.fleet_challans set
    status = case when status in ('recovering','recovered') then status else 'approved_for_recovery' end,
    recovery_month = v_month,
    recovery_case_key = v_key,
    reviewed_by = p_user,
    reviewed_at = now(),
    responsible_note = case when note is null then responsible_note else note end,
    updated_at = now()
  where id = c.id
  returning * into saved;

  insert into public.fleet_challan_events(company_id, challan_id, action, from_status, to_status, actor_id, actor_name, note, metadata)
  values (
    p_company, c.id, 'open_recovery', c.status, saved.status, p_user, coalesce(nullif(btrim(p_name),''),'Fleet user'), note,
    jsonb_build_object('recovery_month', v_month, 'recovery_case_key', v_key)
  );
  return saved;
end;
$$;

revoke all on function public.fleet_challan_upsert_v1(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fleet_challan_set_status_v1(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.fleet_challan_open_recovery_v1(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fleet_challan_upsert_v1(uuid, uuid, jsonb) to service_role;
grant execute on function public.fleet_challan_set_status_v1(uuid, uuid, uuid, text, text, text) to service_role;
grant execute on function public.fleet_challan_open_recovery_v1(uuid, uuid, uuid, text, text) to service_role;

notify pgrst, 'reload schema';
commit;
