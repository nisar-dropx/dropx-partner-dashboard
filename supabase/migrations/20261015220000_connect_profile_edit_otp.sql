-- Self-service profile edits are deliberately separate from onboarding saves.
-- Every request is bound to one authenticated Connect session and one account,
-- stores only a server-normalized mutable-field payload, and is consumed once.

create extension if not exists pgcrypto;

-- Older installations exposed these fields through compatibility fallbacks in
-- the profile GET routes. The atomic updater must be compilable and executable
-- against those installations too, so bring only the already-supported shared
-- profile columns forward before defining it.
alter table public.profiles
  add column if not exists mobile_country_code text not null default '91';

alter table public.employees
  add column if not exists mobile_country_code text not null default '91',
  add column if not exists profile_return_remarks text,
  add column if not exists profile_returned_at timestamptz,
  add column if not exists profile_edit_review_pending boolean not null default false,
  add column if not exists eshram_uan text,
  add column if not exists is_handicapped boolean,
  add column if not exists pf_uan text,
  add column if not exists pf_account_no text,
  add column if not exists esi_no text,
  add column if not exists driving_license_no text,
  add column if not exists driving_license_exp_date date,
  add column if not exists vehicle_reg_no text,
  add column if not exists vehicle_reg_exp_date date,
  add column if not exists vehicle_insurance_exp_date date,
  add column if not exists vehicle_pollution_exp_date date;

do $$
declare
  profile_table text;
begin
  foreach profile_table in array array['workforce', 'contractors', 'vendors']
  loop
    if to_regclass('public.' || profile_table) is null then
      raise exception 'Required profile table public.% is missing.', profile_table;
    end if;
    execute format(
      'alter table public.%I
        add column if not exists mobile_country_code text not null default ''91'',
        add column if not exists profile_return_remarks text,
        add column if not exists profile_returned_at timestamptz,
        add column if not exists profile_edit_review_pending boolean not null default false,
        add column if not exists eshram_uan text,
        add column if not exists pf_uan text,
        add column if not exists pf_account_no text,
        add column if not exists esi_no text',
      profile_table
    );
  end loop;
end
$$;

create table if not exists public.connect_profile_edit_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  account_id uuid not null,
  profile_type text not null check (profile_type in ('employee', 'workforce', 'contractor', 'vendor')),
  login_session_id uuid not null,
  source_updated_at timestamptz not null,
  current_mobile_country_code text not null,
  current_mobile_value text not null,
  current_mobile_number text not null,
  current_mobile_hash text not null,
  new_mobile_country_code text not null,
  new_mobile_value text not null,
  new_mobile_number text not null,
  new_mobile_hash text not null,
  mobile_changed boolean not null,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  before_values jsonb not null default '{}'::jsonb check (jsonb_typeof(before_values) = 'object'),
  payload_hash text not null,
  status text not null default 'created' check (
    status in ('created', 'pending_current', 'pending_new', 'verified', 'committed', 'failed', 'expired', 'cancelled')
  ),
  current_otp_hmac text,
  current_otp_expires_at timestamptz,
  current_otp_attempt_count integer not null default 0 check (current_otp_attempt_count >= 0),
  current_otp_max_attempts integer not null default 5 check (current_otp_max_attempts between 1 and 10),
  current_otp_verified_at timestamptz,
  current_otp_sent_at timestamptz,
  current_otp_send_count integer not null default 0 check (current_otp_send_count >= 0),
  current_provider_metadata jsonb not null default '{}'::jsonb,
  new_otp_hmac text,
  new_otp_expires_at timestamptz,
  new_otp_attempt_count integer not null default 0 check (new_otp_attempt_count >= 0),
  new_otp_max_attempts integer not null default 5 check (new_otp_max_attempts between 1 and 10),
  new_otp_verified_at timestamptz,
  new_otp_sent_at timestamptz,
  new_otp_send_count integer not null default 0 check (new_otp_send_count >= 0),
  new_provider_metadata jsonb not null default '{}'::jsonb,
  request_expires_at timestamptz not null,
  committed_at timestamptz,
  redacted_at timestamptz,
  request_ip text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists connect_profile_edit_requests_one_active
  on public.connect_profile_edit_requests (company_id, profile_type, account_id)
  where status in ('created', 'pending_current', 'pending_new', 'verified');

create index if not exists connect_profile_edit_requests_account_rate
  on public.connect_profile_edit_requests (company_id, profile_type, account_id, created_at desc);

create index if not exists connect_profile_edit_requests_ip_rate
  on public.connect_profile_edit_requests (request_ip, created_at desc)
  where request_ip is not null;

create index if not exists connect_profile_edit_requests_target_rate
  on public.connect_profile_edit_requests (new_mobile_hash, created_at desc);

create table if not exists public.connect_profile_edit_verifications (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references public.connect_profile_edit_requests(id) on delete cascade,
  login_session_id uuid not null,
  company_id uuid not null references public.companies(id) on delete cascade,
  account_id uuid not null,
  profile_type text not null check (profile_type in ('employee', 'workforce', 'contractor', 'vendor')),
  kind text not null check (kind in ('pan', 'pan_aadhaar', 'dl', 'vehicle', 'bank', 'pf_uan')),
  profile_updated_at timestamptz not null,
  identity_name_hash text not null check (identity_name_hash ~ '^[a-f0-9]{64}$'),
  input_key text not null,
  verified boolean not null default false,
  manual_review boolean not null default false,
  block_submit boolean not null default false,
  display_name text,
  message text,
  details jsonb not null default '{}'::jsonb,
  verified_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (login_session_id, company_id, profile_type, account_id, kind)
);

create index if not exists connect_profile_edit_verifications_request
  on public.connect_profile_edit_verifications (request_id, kind, input_key)
  where request_id is not null;

create index if not exists connect_profile_edit_verifications_expiry
  on public.connect_profile_edit_verifications (expires_at);

create table if not exists public.connect_profile_edit_audit (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.connect_profile_edit_requests(id) on delete restrict,
  company_id uuid not null references public.companies(id) on delete cascade,
  account_id uuid not null,
  profile_type text not null,
  login_session_id uuid not null,
  event_code text not null,
  otp_leg text check (otp_leg is null or otp_leg in ('current', 'new')),
  changed_fields text[] not null default '{}',
  before_values jsonb not null default '{}'::jsonb,
  after_values jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  request_ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists connect_profile_edit_audit_account
  on public.connect_profile_edit_audit (company_id, profile_type, account_id, created_at desc);

alter table public.connect_profile_edit_requests enable row level security;
alter table public.connect_profile_edit_verifications enable row level security;
alter table public.connect_profile_edit_audit enable row level security;

revoke all on public.connect_profile_edit_requests from public, anon, authenticated;
revoke all on public.connect_profile_edit_verifications from public, anon, authenticated;
revoke all on public.connect_profile_edit_audit from public, anon, authenticated;
grant select, insert, update on public.connect_profile_edit_requests to service_role;
grant select, insert, update, delete on public.connect_profile_edit_verifications to service_role;
grant select, insert on public.connect_profile_edit_audit to service_role;

-- Reserve a profile-edit start in the database rather than performing a
-- count-then-insert sequence in the API. Locks are acquired in deterministic
-- order for the account, target number and request IP, so parallel starts
-- cannot oversubscribe any hourly bucket. The target-number lock deliberately
-- matches connect_commit_profile_edit, preventing a start availability check
-- from racing a concurrent mobile move.
create or replace function public.connect_reserve_profile_edit_request(
  p_request_id uuid,
  p_company_id uuid,
  p_account_id uuid,
  p_profile_type text,
  p_login_session_id uuid,
  p_source_updated_at timestamptz,
  p_identity_name_hash text,
  p_current_mobile_country_code text,
  p_current_mobile_value text,
  p_current_mobile_number text,
  p_current_mobile_hash text,
  p_new_mobile_country_code text,
  p_new_mobile_value text,
  p_new_mobile_number text,
  p_new_mobile_hash text,
  p_mobile_changed boolean,
  p_payload jsonb,
  p_before_values jsonb,
  p_payload_hash text,
  p_request_expires_at timestamptz,
  p_request_ip text,
  p_user_agent text,
  p_account_limit integer,
  p_target_limit integer,
  p_ip_limit integer
) returns jsonb
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
declare
  reserved_request public.connect_profile_edit_requests%rowtype;
  lock_key bigint;
  target_unavailable boolean := false;
begin
  if p_account_limit < 1 or p_target_limit < 1 or p_ip_limit < 1 then
    raise exception 'Profile edit rate limits are invalid.';
  end if;
  if p_request_expires_at <= now() then
    raise exception 'Profile edit request expiry must be in the future.';
  end if;
  if p_identity_name_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Profile edit identity binding is invalid.';
  end if;

  -- connect_commit_profile_edit locks the active request row before taking the
  -- target-mobile advisory lock. Follow that order here too; otherwise a new
  -- start for the same account could hold the advisory lock while waiting for
  -- a commit that already holds this row.
  perform 1
  from public.connect_profile_edit_requests request
  where request.company_id = p_company_id
    and request.account_id = p_account_id
    and request.profile_type = p_profile_type
    and request.status in ('created', 'pending_current', 'pending_new', 'verified')
  for update;

  -- Sorting avoids deadlocks when two starts share more than one bucket but
  -- encounter those buckets in a different logical order.
  for lock_key in
    select distinct candidate
    from unnest(array[
      pg_catalog.hashtextextended(
        'connect-profile-edit:account:' || p_company_id::text || ':' || p_profile_type || ':' || p_account_id::text,
        0
      ),
      pg_catalog.hashtextextended(
        p_new_mobile_country_code || ':' || p_new_mobile_number,
        0
      ),
      case when nullif(p_request_ip, '') is not null then
        pg_catalog.hashtextextended('connect-profile-edit:ip:' || p_request_ip, 0)
      else null end
    ]::bigint[]) as lock_candidates(candidate)
    where candidate is not null
    order by candidate
  loop
    perform pg_catalog.pg_advisory_xact_lock(lock_key);
  end loop;

  if (
    select count(*)
    from public.connect_profile_edit_requests request
    where request.company_id = p_company_id
      and request.account_id = p_account_id
      and request.profile_type = p_profile_type
      and request.created_at >= now() - interval '1 hour'
  ) >= p_account_limit
  or (
    select count(*)
    from public.connect_profile_edit_requests request
    where request.new_mobile_hash = p_new_mobile_hash
      and request.created_at >= now() - interval '1 hour'
  ) >= p_target_limit
  or (
    nullif(p_request_ip, '') is not null
    and (
      select count(*)
      from public.connect_profile_edit_requests request
      where request.request_ip = p_request_ip
        and request.created_at >= now() - interval '1 hour'
    ) >= p_ip_limit
  ) then
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;

  if p_mobile_changed then
    target_unavailable := exists (
      select 1 from public.profiles profile
      where coalesce(profile.is_active, false)
        and coalesce(profile.mobile_country_code, '91') = p_new_mobile_country_code
        and regexp_replace(coalesce(profile.mobile, ''), '[^0-9]', '', 'g') in (
          p_new_mobile_value,
          p_new_mobile_number
        )
    ) or exists (
      select 1 from public.employees employee
      where coalesce(employee.is_active, false)
        and coalesce(employee.mobile_country_code, '91') = p_new_mobile_country_code
        and regexp_replace(coalesce(employee.mobile, ''), '[^0-9]', '', 'g') in (
          p_new_mobile_value,
          p_new_mobile_number
        )
        and not (
          p_profile_type = 'employee'
          and employee.id = p_account_id
          and employee.company_id = p_company_id
        )
    ) or exists (
      select 1 from public.workforce workforce_profile
      where lower(coalesce(to_jsonb(workforce_profile)->>'onboarding_status', 'pending')) not in ('rejected', 'cancelled')
        and lower(coalesce(to_jsonb(workforce_profile)->>'lifecycle_status', '')) <> 'exited'
        and nullif(to_jsonb(workforce_profile)->>'deleted_at', '') is null
        and coalesce(workforce_profile.mobile_country_code, '91') = p_new_mobile_country_code
        and regexp_replace(coalesce(workforce_profile.mobile, ''), '[^0-9]', '', 'g') in (
          p_new_mobile_value,
          p_new_mobile_number
        )
        and not (
          p_profile_type = 'workforce'
          and workforce_profile.id = p_account_id
          and workforce_profile.company_id = p_company_id
        )
    ) or exists (
      select 1 from public.contractors contractor
      where coalesce(contractor.is_active, false)
        and coalesce(contractor.mobile_country_code, '91') = p_new_mobile_country_code
        and regexp_replace(coalesce(contractor.mobile, ''), '[^0-9]', '', 'g') in (
          p_new_mobile_value,
          p_new_mobile_number
        )
        and not (
          p_profile_type = 'contractor'
          and contractor.id = p_account_id
          and contractor.company_id = p_company_id
        )
    ) or exists (
      select 1 from public.vendors vendor
      where coalesce(vendor.is_active, false)
        and coalesce(vendor.mobile_country_code, '91') = p_new_mobile_country_code
        and regexp_replace(coalesce(vendor.mobile, ''), '[^0-9]', '', 'g') in (
          p_new_mobile_value,
          p_new_mobile_number
        )
        and not (
          p_profile_type = 'vendor'
          and vendor.id = p_account_id
          and vendor.company_id = p_company_id
        )
    );
  end if;

  if target_unavailable then
    -- Keep only the pseudonymous target hash needed for future rate checks.
    -- This rejected probe counts toward all start limits without persisting
    -- either mobile number or the submitted profile values.
    insert into public.connect_profile_edit_requests (
      id, company_id, account_id, profile_type, login_session_id,
      source_updated_at, current_mobile_country_code, current_mobile_value,
      current_mobile_number, current_mobile_hash, new_mobile_country_code,
      new_mobile_value, new_mobile_number, new_mobile_hash, mobile_changed,
      payload, before_values, payload_hash, status, request_expires_at,
      redacted_at, request_ip, user_agent
    ) values (
      p_request_id, p_company_id, p_account_id, p_profile_type, p_login_session_id,
      p_source_updated_at, '', '', '', p_current_mobile_hash, '', '', '',
      p_new_mobile_hash, p_mobile_changed, '{}'::jsonb, '{}'::jsonb,
      p_payload_hash, 'failed', p_request_expires_at, now(),
      nullif(p_request_ip, ''), p_user_agent
    ) returning * into reserved_request;

    insert into public.connect_profile_edit_audit (
      request_id, company_id, account_id, profile_type, login_session_id,
      event_code, metadata, request_ip, user_agent
    ) values (
      reserved_request.id, reserved_request.company_id, reserved_request.account_id,
      reserved_request.profile_type, reserved_request.login_session_id,
      'start_rejected', jsonb_build_object('reason', 'target_unavailable'),
      reserved_request.request_ip, reserved_request.user_agent
    );

    return jsonb_build_object('ok', false, 'code', 'target_unavailable');
  end if;

  update public.connect_profile_edit_verifications
  set request_id = null,
      updated_at = now()
  where login_session_id = p_login_session_id
    and company_id = p_company_id
    and account_id = p_account_id
    and profile_type = p_profile_type;

  update public.connect_profile_edit_requests
  set status = 'cancelled',
      current_otp_hmac = null,
      new_otp_hmac = null,
      payload = '{}'::jsonb,
      before_values = '{}'::jsonb,
      current_mobile_country_code = '',
      current_mobile_value = '',
      current_mobile_number = '',
      new_mobile_country_code = '',
      new_mobile_value = '',
      new_mobile_number = '',
      redacted_at = now(),
      updated_at = now()
  where company_id = p_company_id
    and account_id = p_account_id
    and profile_type = p_profile_type
    and status in ('created', 'pending_current', 'pending_new', 'verified');

  insert into public.connect_profile_edit_requests (
    id, company_id, account_id, profile_type, login_session_id,
    source_updated_at, current_mobile_country_code, current_mobile_value,
    current_mobile_number, current_mobile_hash, new_mobile_country_code,
    new_mobile_value, new_mobile_number, new_mobile_hash, mobile_changed,
    payload, before_values, payload_hash, request_expires_at,
    request_ip, user_agent
  ) values (
    p_request_id, p_company_id, p_account_id, p_profile_type, p_login_session_id,
    p_source_updated_at, p_current_mobile_country_code, p_current_mobile_value,
    p_current_mobile_number, p_current_mobile_hash, p_new_mobile_country_code,
    p_new_mobile_value, p_new_mobile_number, p_new_mobile_hash, p_mobile_changed,
    coalesce(p_payload, '{}'::jsonb), coalesce(p_before_values, '{}'::jsonb),
    p_payload_hash, p_request_expires_at, nullif(p_request_ip, ''), p_user_agent
  ) returning * into reserved_request;

  -- Claim only verification evidence produced for this exact immutable profile
  -- snapshot. Keeping the claim in this transaction prevents an older start
  -- response from reassigning evidence after a newer request supersedes it.
  update public.connect_profile_edit_verifications
  set request_id = p_request_id,
      updated_at = now()
  where login_session_id = p_login_session_id
    and company_id = p_company_id
    and account_id = p_account_id
    and profile_type = p_profile_type
    and profile_updated_at = p_source_updated_at
    and identity_name_hash = p_identity_name_hash
    and expires_at > now();

  return jsonb_build_object('ok', true, 'request', to_jsonb(reserved_request));
end
$$;

revoke all on function public.connect_reserve_profile_edit_request(
  uuid, uuid, uuid, text, uuid, timestamptz, text, text, text, text, text,
  text, text, text, text, boolean, jsonb, jsonb, text, timestamptz,
  text, text, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.connect_reserve_profile_edit_request(
  uuid, uuid, uuid, text, uuid, timestamptz, text, text, text, text, text,
  text, text, text, text, boolean, jsonb, jsonb, text, timestamptz,
  text, text, integer, integer, integer
) to service_role;

-- Canonical DropX One workforce accounts now store verification rows as
-- profile_type='workforce'. Keep legacy field_executive rows readable too.
alter table if exists public.connect_profile_verifications
  drop constraint if exists connect_profile_verifications_profile_type_check;
alter table if exists public.connect_profile_verifications
  add constraint connect_profile_verifications_profile_type_check
  check (profile_type in ('employee', 'field_executive', 'workforce', 'contractor', 'vendor', 'worker'));

create or replace function public.connect_commit_profile_edit(
  p_request_id uuid,
  p_login_session_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
declare
  edit_request public.connect_profile_edit_requests%rowtype;
  profile_before jsonb;
  profile_after jsonb;
  target_table text;
  expected_key text;
  final_pan text;
  final_aadhaar text;
  final_bank text;
  final_ifsc text;
  final_pf text;
  final_dl text;
  final_dob text;
  final_vehicle text;
  changed_fields text[];
  unknown_field text;
  locked_session_id uuid;
  phone_lock_key bigint;
  manual_review_required boolean := false;
  review_pending_after_commit boolean := false;
  source_phone_still_in_use boolean := false;
  expected_identity_name_hash text;
begin
  select * into edit_request
  from public.connect_profile_edit_requests
  where id = p_request_id
  for update;

  if not found then raise exception 'Profile edit request was not found.'; end if;
  if edit_request.login_session_id <> p_login_session_id then
    raise exception 'This profile edit belongs to a different login session.';
  end if;
  if edit_request.status <> 'verified' then
    raise exception 'Verify the WhatsApp OTP before saving.';
  end if;
  if edit_request.request_expires_at <= now() then
    update public.connect_profile_edit_requests set status = 'expired', updated_at = now() where id = edit_request.id;
    raise exception 'Profile edit verification expired. Start again.';
  end if;
  if edit_request.current_otp_verified_at is null or
     (edit_request.mobile_changed and edit_request.new_otp_verified_at is null) then
    raise exception 'Required mobile number verification is incomplete.';
  end if;
  select session.id into locked_session_id
    from public.connect_login_sessions session
    where session.id = p_login_session_id
      and session.revoked_at is null
      and session.expires_at > now()
    for update;
  if locked_session_id is null then
    raise exception 'Connect session expired. Please log in again.';
  end if;

  select key into unknown_field
  from jsonb_object_keys(edit_request.payload) as submitted(key)
  where key <> all(array[
    'gender','date_of_birth','aadhaar_number','pan_number','eshram_uan','is_handicapped',
    'address','state','pincode','landmark','state_code','father_name','blood_group',
    'bank_account_no','ifsc','pf_uan','pf_account_no','esi_no','driving_license_no',
    'driving_license_exp_date','vehicle_reg_no','vehicle_reg_exp_date',
    'vehicle_insurance_exp_date','vehicle_pollution_exp_date','emergency_contact_name',
    'emergency_contact_number','emergency_contact_relation'
  ]::text[])
  limit 1;
  if unknown_field is not null then
    raise exception 'Profile field % cannot be edited.', unknown_field;
  end if;
  if edit_request.profile_type <> 'employee' and edit_request.payload ? 'state' then
    raise exception 'State name cannot be edited for this profile type.';
  end if;

  if edit_request.profile_type = 'employee' then
    select to_jsonb(employee) into profile_before
    from public.employees employee
    where employee.id = edit_request.account_id
      and employee.company_id = edit_request.company_id
    for update;
    if profile_before is null then raise exception 'Employee profile was not found.'; end if;
    if lower(coalesce(profile_before->>'profile_completion_status', '')) <> 'active'
       or coalesce((profile_before->>'is_active')::boolean, true) is not true then
      raise exception 'Only an active profile can be edited.';
    end if;
  else
    target_table := case edit_request.profile_type
      when 'workforce' then 'workforce'
      when 'contractor' then 'contractors'
      when 'vendor' then 'vendors'
      else null
    end;
    if target_table is null then raise exception 'Unsupported profile type.'; end if;
    execute format(
      'select to_jsonb(profile) from public.%I profile where profile.id = $1 and profile.company_id = $2 for update',
      target_table
    ) into profile_before using edit_request.account_id, edit_request.company_id;
    if profile_before is null then raise exception 'Workforce profile was not found.'; end if;
    if lower(coalesce(profile_before->>'onboarding_status', '')) <> 'active'
       or coalesce((profile_before->>'is_active')::boolean, true) is not true
       or profile_before->>'deleted_at' is not null then
      raise exception 'Only an active profile can be edited.';
    end if;
  end if;

  if coalesce(profile_before->>'mobile_country_code', '91') is distinct from edit_request.current_mobile_country_code
     or coalesce(profile_before->>'mobile', '') is distinct from edit_request.current_mobile_value then
    raise exception 'The profile mobile number changed after verification started. Start again.';
  end if;
  if (profile_before->>'updated_at')::timestamptz is distinct from edit_request.source_updated_at then
    raise exception 'The profile changed after verification started. Reload it and try again.';
  end if;

  if edit_request.mobile_changed then
    -- People records may share a contact number through administrator-managed
    -- lifecycle flows, but Connect authentication is still phone-principal:
    -- sessions, PINs and device access resolve every account on the number. A
    -- self-service move to an occupied number would therefore grant the other
    -- holder access to this profile. Serialize the final check with other edits
    -- and require an administrator for that exceptional move.
    -- Legacy Connect authentication keys credentials by the normalized value
    -- supplied by the login route. India-style 10-digit subscribers normalize
    -- to country-prefixed digits, while shorter supported international
    -- subscribers (for example an 8-digit Singapore number) remain local.
    -- Lock both representations for both sides of a move, in deterministic
    -- hash order, so neither form can race the collision check, profile update,
    -- or credential retirement.
    for phone_lock_key in
      select distinct pg_catalog.hashtextextended(phone_key, 0)
      from unnest(array[
        edit_request.current_mobile_country_code || ':' || edit_request.current_mobile_number,
        edit_request.current_mobile_country_code || ':' || regexp_replace(edit_request.current_mobile_value, '[^0-9]', '', 'g'),
        edit_request.current_mobile_country_code || ':' || substring(
          edit_request.current_mobile_number
          from char_length(edit_request.current_mobile_country_code) + 1
        ),
        edit_request.new_mobile_country_code || ':' || edit_request.new_mobile_number,
        edit_request.new_mobile_country_code || ':' || edit_request.new_mobile_value,
        edit_request.new_mobile_country_code || ':' || substring(
          edit_request.new_mobile_number
          from char_length(edit_request.new_mobile_country_code) + 1
        )
      ]) as phone(phone_key)
      where nullif(split_part(phone_key, ':', 2), '') is not null
      order by 1
    loop
      perform pg_catalog.pg_advisory_xact_lock(phone_lock_key);
    end loop;

    if exists (
      select 1 from public.profiles profile
      where coalesce(profile.is_active, false)
        and coalesce(profile.mobile_country_code, '91') = edit_request.new_mobile_country_code
        and regexp_replace(coalesce(profile.mobile, ''), '[^0-9]', '', 'g') in (
          edit_request.new_mobile_value,
          edit_request.new_mobile_number
        )
    ) or exists (
      select 1 from public.employees employee
      where coalesce(employee.is_active, false)
        and coalesce(employee.mobile_country_code, '91') = edit_request.new_mobile_country_code
        and regexp_replace(coalesce(employee.mobile, ''), '[^0-9]', '', 'g') in (
          edit_request.new_mobile_value,
          edit_request.new_mobile_number
        )
        and not (
          edit_request.profile_type = 'employee'
          and employee.id = edit_request.account_id
          and employee.company_id = edit_request.company_id
        )
    ) or exists (
      select 1 from public.workforce workforce_profile
      where lower(coalesce(to_jsonb(workforce_profile)->>'onboarding_status', 'pending')) not in ('rejected', 'cancelled')
        and lower(coalesce(to_jsonb(workforce_profile)->>'lifecycle_status', '')) <> 'exited'
        and nullif(to_jsonb(workforce_profile)->>'deleted_at', '') is null
        and coalesce(workforce_profile.mobile_country_code, '91') = edit_request.new_mobile_country_code
        and regexp_replace(coalesce(workforce_profile.mobile, ''), '[^0-9]', '', 'g') in (
          edit_request.new_mobile_value,
          edit_request.new_mobile_number
        )
        and not (
          edit_request.profile_type = 'workforce'
          and workforce_profile.id = edit_request.account_id
          and workforce_profile.company_id = edit_request.company_id
        )
    ) or exists (
      select 1 from public.contractors contractor
      where coalesce(contractor.is_active, false)
        and coalesce(contractor.mobile_country_code, '91') = edit_request.new_mobile_country_code
        and regexp_replace(coalesce(contractor.mobile, ''), '[^0-9]', '', 'g') in (
          edit_request.new_mobile_value,
          edit_request.new_mobile_number
        )
        and not (
          edit_request.profile_type = 'contractor'
          and contractor.id = edit_request.account_id
          and contractor.company_id = edit_request.company_id
        )
    ) or exists (
      select 1 from public.vendors vendor
      where coalesce(vendor.is_active, false)
        and coalesce(vendor.mobile_country_code, '91') = edit_request.new_mobile_country_code
        and regexp_replace(coalesce(vendor.mobile, ''), '[^0-9]', '', 'g') in (
          edit_request.new_mobile_value,
          edit_request.new_mobile_number
        )
        and not (
          edit_request.profile_type = 'vendor'
          and vendor.id = edit_request.account_id
          and vendor.company_id = edit_request.company_id
        )
    ) then
      raise exception 'This mobile number cannot be used for self-service profile editing. Contact an administrator.';
    end if;
  end if;

  expected_identity_name_hash := encode(digest(
    upper(regexp_replace(btrim(coalesce(profile_before->>'full_name', '')), '[[:space:]]+', ' ', 'g')),
    'sha256'
  ), 'hex');

  final_pan := nullif(upper(btrim(case when edit_request.payload ? 'pan_number' then edit_request.payload->>'pan_number' else profile_before->>'pan_number' end)), '');
  final_aadhaar := nullif(btrim(case when edit_request.payload ? 'aadhaar_number' then edit_request.payload->>'aadhaar_number' else profile_before->>'aadhaar_number' end), '');
  final_bank := nullif(upper(btrim(case when edit_request.payload ? 'bank_account_no' then edit_request.payload->>'bank_account_no' else profile_before->>'bank_account_no' end)), '');
  final_ifsc := nullif(upper(btrim(case when edit_request.payload ? 'ifsc' then edit_request.payload->>'ifsc' else coalesce(profile_before->>'ifsc', profile_before->>'ifsc_code') end)), '');
  final_pf := nullif(upper(btrim(case when edit_request.payload ? 'pf_uan' then edit_request.payload->>'pf_uan' else profile_before->>'pf_uan' end)), '');
  final_dl := nullif(upper(btrim(case when edit_request.payload ? 'driving_license_no' then edit_request.payload->>'driving_license_no' else profile_before->>'driving_license_no' end)), '');
  final_dob := nullif(btrim(case when edit_request.payload ? 'date_of_birth' then edit_request.payload->>'date_of_birth' else profile_before->>'date_of_birth' end), '');
  final_vehicle := nullif(upper(btrim(case when edit_request.payload ? 'vehicle_reg_no' then edit_request.payload->>'vehicle_reg_no' else profile_before->>'vehicle_reg_no' end)), '');

  if final_dob is not null and final_dob::date > (current_date - interval '18 years')::date then
    raise exception 'Profile holder must be at least 18 years old.';
  end if;
  if final_aadhaar is not null and final_pan is null then
    raise exception 'PAN is required when an Aadhaar number is provided.';
  end if;
  if (final_bank is null) <> (final_ifsc is null) then
    raise exception 'Bank account number and IFSC must be provided together.';
  end if;

  if edit_request.payload ? 'pan_number' and final_pan is not null then
    expected_key := upper(final_pan);
    if not exists (
      select 1 from public.connect_profile_edit_verifications verification
      where verification.request_id = edit_request.id
        and verification.login_session_id = edit_request.login_session_id
        and verification.expires_at > now()
        and verification.profile_updated_at = edit_request.source_updated_at
        and verification.identity_name_hash = expected_identity_name_hash
        and verification.company_id = edit_request.company_id
        and verification.profile_type = edit_request.profile_type
        and verification.account_id = edit_request.account_id
        and verification.kind = 'pan'
        and verification.input_key = expected_key
        and verification.block_submit is false
    ) then raise exception 'Verify the updated PAN before saving.'; end if;
  end if;

  if (edit_request.payload ? 'pan_number' or edit_request.payload ? 'aadhaar_number')
     and final_pan is not null and final_aadhaar is not null then
    expected_key := upper(final_pan) || '|' || upper(final_aadhaar);
    if not exists (
      select 1 from public.connect_profile_edit_verifications verification
      where verification.request_id = edit_request.id
        and verification.login_session_id = edit_request.login_session_id
        and verification.expires_at > now()
        and verification.profile_updated_at = edit_request.source_updated_at
        and verification.identity_name_hash = expected_identity_name_hash
        and verification.company_id = edit_request.company_id
        and verification.profile_type = edit_request.profile_type
        and verification.account_id = edit_request.account_id
        and verification.kind = 'pan_aadhaar'
        and verification.input_key = expected_key
        and verification.block_submit is false
    ) then raise exception 'Verify the updated PAN and Aadhaar link before saving.'; end if;
  end if;

  if (edit_request.payload ? 'bank_account_no' or edit_request.payload ? 'ifsc')
     and final_bank is not null and final_ifsc is not null then
    expected_key := upper(final_bank) || '|' || upper(final_ifsc);
    if not exists (
      select 1 from public.connect_profile_edit_verifications verification
      where verification.request_id = edit_request.id
        and verification.login_session_id = edit_request.login_session_id
        and verification.expires_at > now()
        and verification.profile_updated_at = edit_request.source_updated_at
        and verification.identity_name_hash = expected_identity_name_hash
        and verification.company_id = edit_request.company_id
        and verification.profile_type = edit_request.profile_type
        and verification.account_id = edit_request.account_id
        and verification.kind = 'bank'
        and verification.input_key = expected_key
    ) then raise exception 'Check the updated bank account before saving.'; end if;
  end if;

  if edit_request.payload ? 'pf_uan' and final_pf is not null then
    expected_key := upper(final_pf);
    if not exists (
      select 1 from public.connect_profile_edit_verifications verification
      where verification.request_id = edit_request.id
        and verification.login_session_id = edit_request.login_session_id
        and verification.expires_at > now()
        and verification.profile_updated_at = edit_request.source_updated_at
        and verification.identity_name_hash = expected_identity_name_hash
        and verification.company_id = edit_request.company_id
        and verification.profile_type = edit_request.profile_type
        and verification.account_id = edit_request.account_id
        and verification.kind = 'pf_uan'
        and verification.input_key = expected_key
        and verification.block_submit is false
    ) then raise exception 'Verify the updated PF UAN before saving.'; end if;
  end if;

  if (edit_request.payload ? 'driving_license_no' or edit_request.payload ? 'date_of_birth')
     and final_dl is not null then
    if final_dob is null then raise exception 'Date of birth is required to verify the driving licence.'; end if;
    expected_key := upper(final_dl) || '|' || to_char(final_dob::date, 'DD/MM/YYYY');
    if not exists (
      select 1 from public.connect_profile_edit_verifications verification
      where verification.request_id = edit_request.id
        and verification.login_session_id = edit_request.login_session_id
        and verification.expires_at > now()
        and verification.profile_updated_at = edit_request.source_updated_at
        and verification.identity_name_hash = expected_identity_name_hash
        and verification.company_id = edit_request.company_id
        and verification.profile_type = edit_request.profile_type
        and verification.account_id = edit_request.account_id
        and verification.kind = 'dl'
        and verification.input_key = expected_key
        and verification.block_submit is false
    ) then raise exception 'Verify the updated driving licence before saving.'; end if;
  end if;

  if edit_request.payload ? 'vehicle_reg_no' and final_vehicle is not null then
    expected_key := upper(final_vehicle);
    if not exists (
      select 1 from public.connect_profile_edit_verifications verification
      where verification.request_id = edit_request.id
        and verification.login_session_id = edit_request.login_session_id
        and verification.expires_at > now()
        and verification.profile_updated_at = edit_request.source_updated_at
        and verification.identity_name_hash = expected_identity_name_hash
        and verification.company_id = edit_request.company_id
        and verification.profile_type = edit_request.profile_type
        and verification.account_id = edit_request.account_id
        and verification.kind = 'vehicle'
        and verification.input_key = expected_key
    ) then raise exception 'Check the updated vehicle registration before saving.'; end if;
  end if;

  -- Keep the existing review policy for non-blocking identity exceptions: the
  -- edit is saved and independently flagged for human review. Do not change an
  -- active person's registration/lifecycle status; those columns describe
  -- operational access and are protected by the Workforce active-status
  -- invariant.
  -- Vehicle and bank checks remain advisory for now and therefore do not move
  -- an otherwise-active profile into review unless their policy changes later.
  select exists (
    select 1
    from public.connect_profile_edit_verifications verification
    where verification.request_id = edit_request.id
      and verification.login_session_id = edit_request.login_session_id
      and verification.expires_at > now()
      and verification.profile_updated_at = edit_request.source_updated_at
      and verification.identity_name_hash = expected_identity_name_hash
      and verification.company_id = edit_request.company_id
      and verification.profile_type = edit_request.profile_type
      and verification.account_id = edit_request.account_id
      and verification.manual_review is true
      and verification.block_submit is false
      and (
        (verification.kind = 'pan'
          and edit_request.payload ? 'pan_number'
          and final_pan is not null
          and verification.input_key = upper(final_pan))
        or (verification.kind = 'pan_aadhaar'
          and (edit_request.payload ? 'pan_number' or edit_request.payload ? 'aadhaar_number')
          and final_pan is not null and final_aadhaar is not null
          and verification.input_key = upper(final_pan) || '|' || upper(final_aadhaar))
        or (verification.kind = 'pf_uan'
          and edit_request.payload ? 'pf_uan'
          and final_pf is not null
          and verification.input_key = upper(final_pf))
        or (verification.kind = 'dl'
          and (edit_request.payload ? 'driving_license_no' or edit_request.payload ? 'date_of_birth')
          and final_dl is not null and final_dob is not null
          and verification.input_key = upper(final_dl) || '|' || to_char(final_dob::date, 'DD/MM/YYYY'))
      )
  ) into manual_review_required;

  -- Once a self-edit enters human review, only an administrator approval clears
  -- the review flag. A returned correction can be saved through this
  -- OTP-protected flow, but it remains in the review queue even when the user
  -- changes an unrelated field.
  review_pending_after_commit := manual_review_required
    or coalesce((profile_before->>'profile_edit_review_pending')::boolean, false);

  if edit_request.profile_type = 'employee' then
    update public.employees as profile set
      mobile_country_code = edit_request.new_mobile_country_code,
      mobile = edit_request.new_mobile_value,
      gender = case when edit_request.payload ? 'gender' then edit_request.payload->>'gender' else profile.gender end,
      date_of_birth = case when edit_request.payload ? 'date_of_birth' then (edit_request.payload->>'date_of_birth')::date else profile.date_of_birth end,
      aadhaar_number = case when edit_request.payload ? 'aadhaar_number' then edit_request.payload->>'aadhaar_number' else profile.aadhaar_number end,
      pan_number = case when edit_request.payload ? 'pan_number' then edit_request.payload->>'pan_number' else profile.pan_number end,
      eshram_uan = case when edit_request.payload ? 'eshram_uan' then edit_request.payload->>'eshram_uan' else profile.eshram_uan end,
      is_handicapped = case when edit_request.payload ? 'is_handicapped' then (edit_request.payload->>'is_handicapped')::boolean else profile.is_handicapped end,
      address = case when edit_request.payload ? 'address' then edit_request.payload->>'address' else profile.address end,
      state = case when edit_request.payload ? 'state' then edit_request.payload->>'state' else profile.state end,
      pincode = case when edit_request.payload ? 'pincode' then edit_request.payload->>'pincode' else profile.pincode end,
      landmark = case when edit_request.payload ? 'landmark' then edit_request.payload->>'landmark' else profile.landmark end,
      state_code = case when edit_request.payload ? 'state_code' then edit_request.payload->>'state_code' else profile.state_code end,
      father_name = case when edit_request.payload ? 'father_name' then edit_request.payload->>'father_name' else profile.father_name end,
      blood_group = case when edit_request.payload ? 'blood_group' then edit_request.payload->>'blood_group' else profile.blood_group end,
      bank_account_no = case when edit_request.payload ? 'bank_account_no' then edit_request.payload->>'bank_account_no' else profile.bank_account_no end,
      ifsc = case when edit_request.payload ? 'ifsc' then edit_request.payload->>'ifsc' else profile.ifsc end,
      pf_uan = case when edit_request.payload ? 'pf_uan' then edit_request.payload->>'pf_uan' else profile.pf_uan end,
      pf_account_no = case when edit_request.payload ? 'pf_account_no' then edit_request.payload->>'pf_account_no' else profile.pf_account_no end,
      esi_no = case when edit_request.payload ? 'esi_no' then edit_request.payload->>'esi_no' else profile.esi_no end,
      driving_license_no = case when edit_request.payload ? 'driving_license_no' then edit_request.payload->>'driving_license_no' else profile.driving_license_no end,
      driving_license_exp_date = case when edit_request.payload ? 'driving_license_exp_date' then (edit_request.payload->>'driving_license_exp_date')::date else profile.driving_license_exp_date end,
      vehicle_reg_no = case when edit_request.payload ? 'vehicle_reg_no' then edit_request.payload->>'vehicle_reg_no' else profile.vehicle_reg_no end,
      vehicle_reg_exp_date = case when edit_request.payload ? 'vehicle_reg_exp_date' then (edit_request.payload->>'vehicle_reg_exp_date')::date else profile.vehicle_reg_exp_date end,
      vehicle_insurance_exp_date = case when edit_request.payload ? 'vehicle_insurance_exp_date' then (edit_request.payload->>'vehicle_insurance_exp_date')::date else profile.vehicle_insurance_exp_date end,
      vehicle_pollution_exp_date = case when edit_request.payload ? 'vehicle_pollution_exp_date' then (edit_request.payload->>'vehicle_pollution_exp_date')::date else profile.vehicle_pollution_exp_date end,
      emergency_contact_name = case when edit_request.payload ? 'emergency_contact_name' then edit_request.payload->>'emergency_contact_name' else profile.emergency_contact_name end,
      emergency_contact_number = case when edit_request.payload ? 'emergency_contact_number' then edit_request.payload->>'emergency_contact_number' else profile.emergency_contact_number end,
      emergency_contact_relation = case when edit_request.payload ? 'emergency_contact_relation' then edit_request.payload->>'emergency_contact_relation' else profile.emergency_contact_relation end,
      profile_return_remarks = null,
      profile_returned_at = null,
      profile_edit_review_pending = review_pending_after_commit,
      updated_at = now()
    where profile.id = edit_request.account_id and profile.company_id = edit_request.company_id
      returning to_jsonb(profile) into profile_after;
  else
    execute format($update$
      update public.%I as profile set
        mobile_country_code = $1,
        mobile = $2,
        gender = case when $3 ? 'gender' then $3->>'gender' else profile.gender end,
        date_of_birth = case when $3 ? 'date_of_birth' then ($3->>'date_of_birth')::date else profile.date_of_birth end,
        aadhaar_number = case when $3 ? 'aadhaar_number' then $3->>'aadhaar_number' else profile.aadhaar_number end,
        pan_number = case when $3 ? 'pan_number' then $3->>'pan_number' else profile.pan_number end,
        eshram_uan = case when $3 ? 'eshram_uan' then $3->>'eshram_uan' else profile.eshram_uan end,
        is_handicapped = case when $3 ? 'is_handicapped' then ($3->>'is_handicapped')::boolean else profile.is_handicapped end,
        address = case when $3 ? 'address' then $3->>'address' else profile.address end,
        postal_pin = case when $3 ? 'pincode' then $3->>'pincode' else profile.postal_pin end,
        landmark = case when $3 ? 'landmark' then $3->>'landmark' else profile.landmark end,
        state_code = case when $3 ? 'state_code' then $3->>'state_code' else profile.state_code end,
        father_name = case when $3 ? 'father_name' then $3->>'father_name' else profile.father_name end,
        blood_group = case when $3 ? 'blood_group' then $3->>'blood_group' else profile.blood_group end,
        bank_account_no = case when $3 ? 'bank_account_no' then $3->>'bank_account_no' else profile.bank_account_no end,
        ifsc_code = case when $3 ? 'ifsc' then $3->>'ifsc' else profile.ifsc_code end,
        pf_uan = case when $3 ? 'pf_uan' then $3->>'pf_uan' else profile.pf_uan end,
        pf_account_no = case when $3 ? 'pf_account_no' then $3->>'pf_account_no' else profile.pf_account_no end,
        esi_no = case when $3 ? 'esi_no' then $3->>'esi_no' else profile.esi_no end,
        driving_license_no = case when $3 ? 'driving_license_no' then $3->>'driving_license_no' else profile.driving_license_no end,
        driving_license_exp_date = case when $3 ? 'driving_license_exp_date' then ($3->>'driving_license_exp_date')::date else profile.driving_license_exp_date end,
        vehicle_reg_no = case when $3 ? 'vehicle_reg_no' then $3->>'vehicle_reg_no' else profile.vehicle_reg_no end,
        vehicle_reg_exp_date = case when $3 ? 'vehicle_reg_exp_date' then ($3->>'vehicle_reg_exp_date')::date else profile.vehicle_reg_exp_date end,
        vehicle_insurance_exp_date = case when $3 ? 'vehicle_insurance_exp_date' then ($3->>'vehicle_insurance_exp_date')::date else profile.vehicle_insurance_exp_date end,
        vehicle_pollution_exp_date = case when $3 ? 'vehicle_pollution_exp_date' then ($3->>'vehicle_pollution_exp_date')::date else profile.vehicle_pollution_exp_date end,
        emergency_contact_name = case when $3 ? 'emergency_contact_name' then $3->>'emergency_contact_name' else profile.emergency_contact_name end,
        emergency_contact_number = case when $3 ? 'emergency_contact_number' then $3->>'emergency_contact_number' else profile.emergency_contact_number end,
        emergency_contact_relation = case when $3 ? 'emergency_contact_relation' then $3->>'emergency_contact_relation' else profile.emergency_contact_relation end,
        profile_return_remarks = null,
        profile_returned_at = null,
        profile_edit_review_pending = $6,
        updated_at = now()
      where profile.id = $4 and profile.company_id = $5
      returning to_jsonb(profile)
    $update$, target_table)
    into profile_after using
      edit_request.new_mobile_country_code,
      edit_request.new_mobile_value,
      edit_request.payload,
      edit_request.account_id,
      edit_request.company_id,
      review_pending_after_commit;
  end if;

  if profile_after is null then raise exception 'Profile could not be updated.'; end if;

  insert into public.connect_profile_verifications (
    company_id, profile_type, account_id, kind, input_key, verified,
    manual_review, block_submit, display_name, message, details,
    verified_at, created_at, updated_at
  )
  select
    verification.company_id, verification.profile_type, verification.account_id,
    verification.kind, verification.input_key, verification.verified,
    verification.manual_review, verification.block_submit,
    verification.display_name, verification.message,
    verification.details || jsonb_build_object(
      'profileEdit', true,
      'profileEditRequestId', edit_request.id::text
    ),
    verification.verified_at, now(), now()
  from public.connect_profile_edit_verifications verification
  where verification.request_id = edit_request.id
    and verification.login_session_id = edit_request.login_session_id
    and verification.expires_at > now()
    and verification.profile_updated_at = edit_request.source_updated_at
    and verification.identity_name_hash = expected_identity_name_hash
    and (
      (verification.kind = 'pan'
        and edit_request.payload ? 'pan_number'
        and final_pan is not null
        and verification.input_key = upper(final_pan))
      or (verification.kind = 'pan_aadhaar'
        and (edit_request.payload ? 'pan_number' or edit_request.payload ? 'aadhaar_number')
        and final_pan is not null and final_aadhaar is not null
        and verification.input_key = upper(final_pan) || '|' || upper(final_aadhaar))
      or (verification.kind = 'bank'
        and (edit_request.payload ? 'bank_account_no' or edit_request.payload ? 'ifsc')
        and final_bank is not null and final_ifsc is not null
        and verification.input_key = upper(final_bank) || '|' || upper(final_ifsc))
      or (verification.kind = 'pf_uan'
        and edit_request.payload ? 'pf_uan'
        and final_pf is not null
        and verification.input_key = upper(final_pf))
      or (verification.kind = 'dl'
        and (edit_request.payload ? 'driving_license_no' or edit_request.payload ? 'date_of_birth')
        and final_dl is not null and final_dob is not null
        and verification.input_key = upper(final_dl) || '|' || to_char(final_dob::date, 'DD/MM/YYYY'))
      or (verification.kind = 'vehicle'
        and edit_request.payload ? 'vehicle_reg_no'
        and final_vehicle is not null
        and verification.input_key = upper(final_vehicle))
    )
  on conflict (company_id, profile_type, account_id, kind) do update set
    input_key = excluded.input_key,
    verified = excluded.verified,
    manual_review = excluded.manual_review,
    block_submit = excluded.block_submit,
    display_name = excluded.display_name,
    message = excluded.message,
    details = excluded.details,
    verified_at = excluded.verified_at,
    updated_at = now();

  -- A verification row is a cache for one exact input key. Once any underlying
  -- value differs, it must never appear as a valid check for the edited profile.
  update public.connect_profile_verifications verification set
    verified = false,
    manual_review = false,
    block_submit = false,
    message = 'Profile value changed. Verify again before the next edit.',
    verified_at = null,
    updated_at = now()
  where verification.company_id = edit_request.company_id
    and verification.profile_type = edit_request.profile_type
    and verification.account_id = edit_request.account_id
    and verification.input_key is distinct from case verification.kind
      when 'pan' then upper(coalesce(final_pan, ''))
      when 'pan_aadhaar' then upper(coalesce(final_pan, '')) || '|' || upper(coalesce(final_aadhaar, ''))
      when 'bank' then upper(coalesce(final_bank, '')) || '|' || upper(coalesce(final_ifsc, ''))
      when 'pf_uan' then upper(coalesce(final_pf, ''))
      when 'dl' then upper(coalesce(final_dl, '')) || '|' || coalesce(to_char(final_dob::date, 'DD/MM/YYYY'), '')
      when 'vehicle' then upper(coalesce(final_vehicle, ''))
      else verification.input_key
    end;

  select coalesce(array_agg(key order by key), '{}'::text[]) into changed_fields
  from jsonb_object_keys(edit_request.payload) as submitted(key);
  if edit_request.mobile_changed then
    changed_fields := array_append(changed_fields, 'mobile');
  end if;

  update public.connect_account_devices device set
    country_code = edit_request.new_mobile_country_code,
    mobile_number = edit_request.new_mobile_number,
    updated_at = now()
  where device.account_id = edit_request.account_id
    and device.company_id = edit_request.company_id
    and device.reset_at is null
    and (
      device.profile_type = edit_request.profile_type
      or (edit_request.profile_type = 'workforce' and device.profile_type = 'field_executive')
    );

  if edit_request.mobile_changed then
    -- The locked collision check above proves the target has no active account.
    -- Clear credentials left behind by a recycled number before this profile
    -- becomes reachable there, then revoke the editing session so the user must
    -- authenticate again on the newly verified number.
    update public.connect_login_sessions
    set revoked_at = now()
    where revoked_at is null
      and country_code = edit_request.new_mobile_country_code
      and mobile_number in (edit_request.new_mobile_value, edit_request.new_mobile_number);

    update public.connect_user_pins
    set attempt_count = 0,
        locked_until = null,
        reset_required = true,
        updated_at = now()
    where country_code = edit_request.new_mobile_country_code
      and mobile_number in (edit_request.new_mobile_value, edit_request.new_mobile_number);

    update public.connect_whatsapp_otp_requests
    set status = 'expired', updated_at = now()
    where country_code = edit_request.new_mobile_country_code
      and mobile_number in (edit_request.new_mobile_value, edit_request.new_mobile_number)
      and purpose in ('connect_login', 'connect_pin_reset')
      and status = 'pending';

    update public.connect_sms_otp_requests
    set status = 'expired', updated_at = now()
    where country_code = edit_request.new_mobile_country_code
      and mobile_number in (edit_request.new_mobile_value, edit_request.new_mobile_number)
      and purpose in ('connect_login', 'connect_pin_reset')
      and status = 'pending';

    -- A Connect session is a phone principal, not an account principal. Once
    -- the edited profile leaves its old number, retire every credential for
    -- that number unless another currently eligible account still uses it.
    -- This prevents a stale PIN or session from authenticating a future holder
    -- if the old number is later assigned to a different profile.
    select (
      exists (
        select 1 from public.profiles profile
        where coalesce(profile.is_active, false)
          and coalesce(profile.mobile_country_code, '91') = edit_request.current_mobile_country_code
          and regexp_replace(coalesce(profile.mobile, ''), '[^0-9]', '', 'g') in (
            edit_request.current_mobile_value,
            edit_request.current_mobile_number
          )
      ) or exists (
        select 1 from public.employees employee
        where coalesce(employee.is_active, false)
          and coalesce(employee.mobile_country_code, '91') = edit_request.current_mobile_country_code
          and regexp_replace(coalesce(employee.mobile, ''), '[^0-9]', '', 'g') in (
            edit_request.current_mobile_value,
            edit_request.current_mobile_number
          )
      ) or exists (
        select 1 from public.workforce workforce_profile
        where lower(coalesce(to_jsonb(workforce_profile)->>'onboarding_status', 'pending')) not in ('rejected', 'cancelled')
          and lower(coalesce(to_jsonb(workforce_profile)->>'lifecycle_status', '')) <> 'exited'
          and nullif(to_jsonb(workforce_profile)->>'deleted_at', '') is null
          and coalesce(workforce_profile.mobile_country_code, '91') = edit_request.current_mobile_country_code
          and regexp_replace(coalesce(workforce_profile.mobile, ''), '[^0-9]', '', 'g') in (
            edit_request.current_mobile_value,
            edit_request.current_mobile_number
          )
      ) or exists (
        select 1 from public.contractors contractor
        where coalesce(contractor.is_active, false)
          and coalesce(contractor.mobile_country_code, '91') = edit_request.current_mobile_country_code
          and regexp_replace(coalesce(contractor.mobile, ''), '[^0-9]', '', 'g') in (
            edit_request.current_mobile_value,
            edit_request.current_mobile_number
          )
      ) or exists (
        select 1 from public.vendors vendor
        where coalesce(vendor.is_active, false)
          and coalesce(vendor.mobile_country_code, '91') = edit_request.current_mobile_country_code
          and regexp_replace(coalesce(vendor.mobile, ''), '[^0-9]', '', 'g') in (
            edit_request.current_mobile_value,
            edit_request.current_mobile_number
          )
      )
    ) into source_phone_still_in_use;

    if not source_phone_still_in_use then
      update public.connect_login_sessions
      set revoked_at = now()
      where revoked_at is null
        and country_code = edit_request.current_mobile_country_code
        and mobile_number in (edit_request.current_mobile_value, edit_request.current_mobile_number);

      update public.connect_user_pins
      set attempt_count = 0,
          locked_until = null,
          reset_required = true,
          updated_at = now()
      where country_code = edit_request.current_mobile_country_code
        and mobile_number in (edit_request.current_mobile_value, edit_request.current_mobile_number);

      update public.connect_whatsapp_otp_requests
      set status = 'expired', updated_at = now()
      where country_code = edit_request.current_mobile_country_code
        and mobile_number in (edit_request.current_mobile_value, edit_request.current_mobile_number)
        and purpose in ('connect_login', 'connect_pin_reset')
        and status = 'pending';

      update public.connect_sms_otp_requests
      set status = 'expired', updated_at = now()
      where country_code = edit_request.current_mobile_country_code
        and mobile_number in (edit_request.current_mobile_value, edit_request.current_mobile_number)
        and purpose in ('connect_login', 'connect_pin_reset')
        and status = 'pending';
    end if;

    update public.connect_login_sessions
    set revoked_at = now()
    where id = p_login_session_id and revoked_at is null;
  end if;

  update public.connect_profile_edit_requests set
    status = 'committed',
    current_otp_hmac = null,
    new_otp_hmac = null,
    committed_at = now(),
    updated_at = now()
  where id = edit_request.id;

  insert into public.connect_profile_edit_audit (
    request_id, company_id, account_id, profile_type, login_session_id,
    event_code, changed_fields, before_values, after_values, metadata,
    request_ip, user_agent
  ) values (
    edit_request.id, edit_request.company_id, edit_request.account_id,
    edit_request.profile_type, edit_request.login_session_id, 'committed',
    changed_fields, '{}'::jsonb, '{}'::jsonb,
    jsonb_build_object(
      'session_revoked', edit_request.mobile_changed,
      'source_credentials_retired', edit_request.mobile_changed and not source_phone_still_in_use,
      'manual_review_required', review_pending_after_commit,
      'payload_hmac', edit_request.payload_hash
    ),
    edit_request.request_ip, edit_request.user_agent
  );

  delete from public.connect_profile_edit_verifications
  where request_id = edit_request.id;

  update public.connect_profile_edit_requests set
    payload = '{}'::jsonb,
    before_values = '{}'::jsonb,
    current_mobile_country_code = '',
    current_mobile_value = '',
    current_mobile_number = '',
    new_mobile_country_code = '',
    new_mobile_value = '',
    new_mobile_number = '',
    redacted_at = now()
  where id = edit_request.id;

  return jsonb_build_object(
    'ok', true,
    'sessionRevoked', edit_request.mobile_changed,
    'manualReviewRequired', review_pending_after_commit,
    'notice', case
      when edit_request.mobile_changed and review_pending_after_commit
        then 'Profile saved and sent for review. Sign in again with the new mobile number.'
      when edit_request.mobile_changed
        then 'Profile saved. Sign in again with the new mobile number.'
      when review_pending_after_commit
        then 'Profile saved and sent for review.'
      else 'Profile saved successfully.'
    end
  );
end;
$$;

revoke all on function public.connect_commit_profile_edit(uuid, uuid) from public, anon, authenticated;
grant execute on function public.connect_commit_profile_edit(uuid, uuid) to service_role;

-- PIN/OTP validation and session insertion must share the same transaction and
-- target-mobile advisory lock as connect_commit_profile_edit. Otherwise an
-- authentication request that read a stale credential before a mobile change
-- could insert a fresh session after the commit revoked the old sessions.
create or replace function public.connect_authenticate_pin_and_create_session(
  p_country_code text,
  p_mobile_number text,
  p_pin text,
  p_session_id uuid,
  p_session_hash text,
  p_expires_at timestamptz,
  p_request_ip text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
declare
  pin_record record;
  next_attempts integer;
  pin_salt text;
  pin_digest text;
begin
  if p_country_code !~ '^[0-9]{1,4}$'
     or p_mobile_number !~ '^[0-9]{7,15}$'
     or p_pin !~ '^[0-9]{6}$'
     or p_session_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_country_code || ':' || p_mobile_number, 0)
  );

  select pin.* into pin_record
  from public.connect_user_pins pin
  where pin.country_code = p_country_code
    and pin.mobile_number = p_mobile_number
  for update;

  if not found or coalesce(pin_record.reset_required, false) then
    return jsonb_build_object('ok', false, 'code', 'pin_setup_required');
  end if;
  if pin_record.locked_until is not null and pin_record.locked_until > now() then
    return jsonb_build_object('ok', false, 'code', 'pin_locked');
  end if;

  pin_salt := split_part(coalesce(pin_record.pin_hash, ''), ':', 1);
  pin_digest := split_part(coalesce(pin_record.pin_hash, ''), ':', 2);
  if pin_salt = '' or pin_digest = '' or pin_digest is distinct from
     encode(digest(pin_salt || ':' || p_pin, 'sha256'), 'hex') then
    next_attempts := coalesce(pin_record.attempt_count, 0) + 1;
    update public.connect_user_pins set
      attempt_count = next_attempts,
      locked_until = case when next_attempts >= 5 then now() + interval '15 minutes' else null end,
      updated_at = now()
    where id = pin_record.id;
    return jsonb_build_object(
      'ok', false,
      'code', case when next_attempts >= 5 then 'pin_locked' else 'invalid_pin' end
    );
  end if;

  update public.connect_user_pins set
    attempt_count = 0,
    locked_until = null,
    updated_at = now()
  where id = pin_record.id;

  insert into public.connect_login_sessions (
    id, country_code, mobile_number, session_hash,
    expires_at, request_ip, user_agent
  ) values (
    p_session_id, p_country_code, p_mobile_number, p_session_hash,
    p_expires_at, p_request_ip, p_user_agent
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.connect_authenticate_pin_and_create_session(
  text, text, text, uuid, text, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.connect_authenticate_pin_and_create_session(
  text, text, text, uuid, text, timestamptz, text, text
) to service_role;

create or replace function public.connect_set_pin_and_create_session(
  p_country_code text,
  p_mobile_number text,
  p_otp text,
  p_new_pin_hash text,
  p_session_id uuid,
  p_session_hash text,
  p_expires_at timestamptz,
  p_request_ip text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
declare
  otp_record record;
  next_attempts integer;
  otp_salt text;
  otp_digest text;
begin
  if p_country_code !~ '^[0-9]{1,4}$'
     or p_mobile_number !~ '^[0-9]{7,15}$'
     or p_otp !~ '^[0-9]{6}$'
     or p_new_pin_hash !~ '^[^:]+:[a-f0-9]{64}$'
     or p_session_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_country_code || ':' || p_mobile_number, 0)
  );

  select otp.* into otp_record
  from public.connect_whatsapp_otp_requests otp
  where otp.country_code = p_country_code
    and otp.mobile_number = p_mobile_number
    and otp.status = 'pending'
    and otp.purpose in ('connect_login', 'connect_pin_reset')
  order by otp.created_at desc
  limit 1
  for update;

  if not found or otp_record.used_at is not null then
    return jsonb_build_object('ok', false, 'code', 'otp_missing');
  end if;
  if otp_record.expires_at <= now() then
    update public.connect_whatsapp_otp_requests set
      status = 'expired', updated_at = now()
    where id = otp_record.id;
    return jsonb_build_object('ok', false, 'code', 'otp_expired');
  end if;
  if coalesce(otp_record.attempt_count, 0) >= coalesce(otp_record.max_attempts, 5) then
    update public.connect_whatsapp_otp_requests set
      status = 'failed', updated_at = now()
    where id = otp_record.id;
    return jsonb_build_object('ok', false, 'code', 'otp_locked');
  end if;

  otp_salt := split_part(coalesce(otp_record.otp_hash, ''), ':', 1);
  otp_digest := split_part(coalesce(otp_record.otp_hash, ''), ':', 2);
  if otp_salt = '' or otp_digest = '' or otp_digest is distinct from
     encode(digest(otp_salt || ':' || p_otp, 'sha256'), 'hex') then
    next_attempts := coalesce(otp_record.attempt_count, 0) + 1;
    update public.connect_whatsapp_otp_requests set
      attempt_count = next_attempts,
      status = case when next_attempts >= coalesce(otp_record.max_attempts, 5) then 'failed' else status end,
      request_ip = p_request_ip,
      user_agent = p_user_agent,
      updated_at = now()
    where id = otp_record.id;
    return jsonb_build_object(
      'ok', false,
      'code', case
        when next_attempts >= coalesce(otp_record.max_attempts, 5) then 'otp_locked'
        else 'invalid_otp'
      end
    );
  end if;

  update public.connect_whatsapp_otp_requests set
    status = 'verified',
    used_at = now(),
    attempt_count = coalesce(otp_record.attempt_count, 0) + 1,
    request_ip = p_request_ip,
    user_agent = p_user_agent,
    updated_at = now()
  where id = otp_record.id;

  update public.connect_whatsapp_otp_requests set
    status = 'cancelled',
    updated_at = now()
  where country_code = p_country_code
    and mobile_number = p_mobile_number
    and purpose in ('connect_login', 'connect_pin_reset')
    and status = 'pending'
    and id <> otp_record.id;

  insert into public.connect_user_pins (
    country_code, mobile_number, pin_hash, attempt_count,
    locked_until, reset_required, updated_at
  ) values (
    p_country_code, p_mobile_number, p_new_pin_hash, 0,
    null, false, now()
  )
  on conflict (country_code, mobile_number) do update set
    pin_hash = excluded.pin_hash,
    attempt_count = 0,
    locked_until = null,
    reset_required = false,
    updated_at = now();

  insert into public.connect_login_sessions (
    id, country_code, mobile_number, session_hash,
    expires_at, request_ip, user_agent
  ) values (
    p_session_id, p_country_code, p_mobile_number, p_session_hash,
    p_expires_at, p_request_ip, p_user_agent
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.connect_set_pin_and_create_session(
  text, text, text, text, uuid, text, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.connect_set_pin_and_create_session(
  text, text, text, text, uuid, text, timestamptz, text, text
) to service_role;

create or replace function public.connect_redact_expired_profile_edits()
returns integer
language plpgsql
security definer
set search_path = extensions, public, pg_temp
as $$
declare
  affected integer;
begin
  delete from public.connect_profile_edit_verifications
  where expires_at <= now()
     or request_id in (
       select id from public.connect_profile_edit_requests
       where status in ('committed', 'failed', 'expired', 'cancelled')
     );

  update public.connect_profile_edit_requests set
    status = case when status in ('created', 'pending_current', 'pending_new', 'verified') then 'expired' else status end,
    payload = '{}'::jsonb,
    before_values = '{}'::jsonb,
    current_mobile_country_code = '',
    current_mobile_value = '',
    current_mobile_number = '',
    new_mobile_country_code = '',
    new_mobile_value = '',
    new_mobile_number = '',
    current_otp_hmac = null,
    new_otp_hmac = null,
    redacted_at = coalesce(redacted_at, now()),
    updated_at = now()
  where redacted_at is null
    and (
      request_expires_at <= now()
      or status in ('committed', 'failed', 'expired', 'cancelled')
    );
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.connect_redact_expired_profile_edits() from public, anon, authenticated;
grant execute on function public.connect_redact_expired_profile_edits() to service_role;
