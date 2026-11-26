begin;
-- Challan recovery bank deposit: Cluster submits proof → SLP verifies → case recovered (no payroll due).

alter table public.fleet_challan_recovery_cases
  add column if not exists bank_deposit jsonb not null default '{}'::jsonb;

create table if not exists public.fleet_challan_recovery_attachments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  case_id uuid not null references public.fleet_challan_recovery_cases(id) on delete cascade,
  file_name text not null,
  storage_bucket text not null,
  storage_path text not null,
  content_type text not null default '',
  file_size integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists fleet_challan_recovery_attachments_case_idx
  on public.fleet_challan_recovery_attachments(company_id, case_id);
alter table public.fleet_challan_recovery_attachments enable row level security;
revoke all on public.fleet_challan_recovery_attachments from public, anon, authenticated;
grant all on public.fleet_challan_recovery_attachments to service_role;

create or replace function public.fleet_challan_recovery_bank_deposit_v1(
  p_company uuid, p_case uuid, p_user uuid, p_name text, p_details jsonb, p_remarks text default null
) returns public.fleet_challan_recovery_cases
language plpgsql
security invoker
set search_path = public
as $$
declare
  k public.fleet_challan_recovery_cases;
  saved public.fleet_challan_recovery_cases;
  v_name text := coalesce(nullif(btrim(p_name), ''), 'Fleet user');
  attachment jsonb;
  attachment_id text;
  attachment_count int := 0;
begin
  select * into k from public.fleet_challan_recovery_cases where company_id = p_company and id = p_case for update;
  if not found then raise exception 'Challan recovery case was not found.'; end if;
  if k.status in ('recovered', 'closed', 'cancelled') then
    raise exception 'This recovery case is %, so a bank deposit cannot be submitted.', k.status;
  end if;
  if coalesce(p_details->>'received_amount', '') !~ '^[0-9]+(\.[0-9]{1,2})?$' then
    raise exception 'Enter the full deposited amount.';
  end if;
  if round((p_details->>'received_amount')::numeric, 2) <> round(k.amount, 2) then
    raise exception 'Full recovery must equal the challan amount. Partial collections remain outstanding.';
  end if;
  if length(trim(coalesce(p_details->>'receipt_reference', ''))) < 5
     or coalesce(p_details->>'received_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Transaction number and received date are required.';
  end if;
  if (p_details->>'received_date')::date > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'Received date cannot be in the future.';
  end if;
  if jsonb_typeof(coalesce(p_details->'attachments', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_details->'attachments', '[]'::jsonb)) < 1 then
    raise exception 'Attach a screenshot or proof of the bank deposit for SLP verification.';
  end if;
  for attachment in select value from jsonb_array_elements(coalesce(p_details->'attachments', '[]'::jsonb))
  loop
    attachment_id := nullif(btrim(coalesce(attachment->>'id', '')), '');
    if attachment_id is null or attachment_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Attach a screenshot or proof of the bank deposit for SLP verification.';
    end if;
    select count(*) into attachment_count
      from public.fleet_challan_recovery_attachments f
     where f.company_id = p_company and f.case_id = p_case and f.id = attachment_id::uuid;
    if attachment_count < 1 then
      raise exception 'Upload the bank deposit screenshot again before saving.';
    end if;
  end loop;

  -- Bank deposit replaces any planned payroll recovery for this challan.
  update public.fleet_challan_recovery_allocations
     set status = 'cancelled', updated_by = p_user, updated_by_name = v_name, updated_at = now()
   where company_id = p_company and case_id = p_case and status not in ('cancelled', 'waived', 'deducted', 'recovered');

  if exists (
    select 1 from public.fleet_challan_recovery_allocations
     where company_id = p_company and case_id = p_case and status in ('deducted', 'recovered')
  ) then
    raise exception 'Payroll has already deducted part of this challan. Bank deposit cannot replace deducted lines.';
  end if;

  update public.fleet_challan_recovery_cases set
    status = 'bank_pending',
    bank_deposit = jsonb_build_object(
      'received_amount', round((p_details->>'received_amount')::numeric, 2),
      'receipt_reference', btrim(p_details->>'receipt_reference'),
      'received_date', p_details->>'received_date',
      'attachments', coalesce(p_details->'attachments', '[]'::jsonb),
      'remarks', nullif(btrim(coalesce(p_remarks, '')), ''),
      'approval_status', 'proposed',
      'proposed_by', p_user,
      'proposed_by_name', v_name,
      'proposed_at', to_jsonb(now())
    ),
    updated_at = now()
  where id = p_case
  returning * into saved;

  insert into public.fleet_challan_recovery_events(company_id, case_id, action, before_value, after_value, actor_id, actor_name)
  values (
    p_company, p_case, 'bank_deposit_propose',
    jsonb_build_object('status', k.status, 'bank_deposit', k.bank_deposit),
    jsonb_build_object('status', saved.status, 'bank_deposit', saved.bank_deposit),
    p_user, v_name
  );
  return saved;
end;
$$;

create or replace function public.fleet_challan_recovery_bank_review_v1(
  p_company uuid, p_case uuid, p_user uuid, p_name text, p_action text, p_note text default null
) returns public.fleet_challan_recovery_cases
language plpgsql
security invoker
set search_path = public
as $$
declare
  k public.fleet_challan_recovery_cases;
  saved public.fleet_challan_recovery_cases;
  v_name text := coalesce(nullif(btrim(p_name), ''), 'Fleet user');
  v_action text := lower(coalesce(nullif(btrim(p_action), ''), ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  proposed_by text;
begin
  select * into k from public.fleet_challan_recovery_cases where company_id = p_company and id = p_case for update;
  if not found then raise exception 'Challan recovery case was not found.'; end if;
  if k.status <> 'bank_pending' or coalesce(k.bank_deposit->>'approval_status', '') <> 'proposed' then
    raise exception 'This challan is not waiting for bank deposit verification.';
  end if;
  proposed_by := coalesce(k.bank_deposit->>'proposed_by', '');
  if proposed_by <> '' and proposed_by = p_user::text then
    raise exception 'You proposed this bank deposit, so another authorised person must verify it.';
  end if;
  if v_action not in ('approve', 'return') then
    raise exception 'Choose approve or return.';
  end if;
  if v_action = 'return' and (v_note is null or length(v_note) < 10) then
    raise exception 'Record why the bank deposit must be corrected (at least 10 characters).';
  end if;
  if v_note is not null and length(v_note) > 2000 then
    raise exception 'Keep the note under 2,000 characters.';
  end if;

  if v_action = 'approve' then
    update public.fleet_challan_recovery_cases set
      status = 'recovered',
      bank_deposit = k.bank_deposit || jsonb_build_object(
        'approval_status', 'approved',
        'approved_by', p_user,
        'approved_by_name', v_name,
        'approved_at', to_jsonb(now()),
        'approval_note', coalesce(v_note, '')
      ),
      updated_at = now()
    where id = p_case
    returning * into saved;
  else
    update public.fleet_challan_recovery_cases set
      status = 'open',
      bank_deposit = k.bank_deposit || jsonb_build_object(
        'approval_status', 'returned',
        'approved_by', p_user,
        'approved_by_name', v_name,
        'approved_at', to_jsonb(now()),
        'approval_note', v_note
      ),
      updated_at = now()
    where id = p_case
    returning * into saved;
  end if;

  insert into public.fleet_challan_recovery_events(company_id, case_id, action, before_value, after_value, actor_id, actor_name)
  values (
    p_company, p_case, 'bank_deposit_' || v_action,
    jsonb_build_object('status', k.status, 'bank_deposit', k.bank_deposit),
    jsonb_build_object('status', saved.status, 'bank_deposit', saved.bank_deposit, 'note', v_note),
    p_user, v_name
  );
  return saved;
end;
$$;

revoke all on function public.fleet_challan_recovery_bank_deposit_v1(uuid, uuid, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.fleet_challan_recovery_bank_deposit_v1(uuid, uuid, uuid, text, jsonb, text) to service_role;
revoke all on function public.fleet_challan_recovery_bank_review_v1(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.fleet_challan_recovery_bank_review_v1(uuid, uuid, uuid, text, text, text) to service_role;

notify pgrst, 'reload schema';
commit;
