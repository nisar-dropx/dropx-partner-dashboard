begin;
-- Live NL/SLP loss lifecycle: case workflow + Cluster propose → SLP approve gate before payroll.
-- Money still moves only through nl_loss_recovery_due → HRMS / Workforce. Legacy plans stay approved.
-- Idempotent: safe to re-run.

-- ─── 1. Case lifecycle columns ───────────────────────────────────────────────
alter table public.nl_loss_month_cases
  add column if not exists data_source text,
  add column if not exists lifecycle_status text not null default 'imported',
  add column if not exists lifecycle_version int not null default 1,
  add column if not exists lifecycle_note text not null default '',
  add column if not exists lifecycle_updated_by uuid,
  add column if not exists lifecycle_updated_by_name text,
  add column if not exists lifecycle_updated_at timestamptz;

do $$ begin
  alter table public.nl_loss_month_cases drop constraint if exists nl_loss_lifecycle_status_check;
  alter table public.nl_loss_month_cases add constraint nl_loss_lifecycle_status_check check (
    lifecycle_status in (
      'imported','station_dispute_or_clarification_window','cluster_validation_pending',
      'slp_final_confirmation_pending','recovery_approved_scheduled','recovery_in_progress','recovered',
      'returned_to_station','rejected','not_recoverable','on_hold','needs_review','exit_balance','written_off'
    )
  );
exception when others then null;
end $$;

create table if not exists public.nl_loss_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  month text not null,
  case_key text not null,
  action text not null,
  from_status text,
  to_status text not null,
  note text not null default '',
  actor_id uuid,
  actor_name text,
  snapshot jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists nl_loss_lifecycle_events_case_idx
  on public.nl_loss_lifecycle_events(company_id, month, case_key, created_at desc);

create or replace function public.nl_loss_lifecycle_events_immutable() returns trigger
language plpgsql set search_path=public as $$
begin raise exception 'Loss lifecycle history cannot be changed.'; end $$;
drop trigger if exists nl_loss_lifecycle_events_immutable on public.nl_loss_lifecycle_events;
create trigger nl_loss_lifecycle_events_immutable
  before update or delete on public.nl_loss_lifecycle_events
  for each row execute function public.nl_loss_lifecycle_events_immutable();

alter table public.nl_loss_lifecycle_events enable row level security;
revoke all on public.nl_loss_lifecycle_events from public, anon, authenticated;
grant select, insert on public.nl_loss_lifecycle_events to service_role;

-- ─── 2. Recovery approval columns ────────────────────────────────────────────
alter table public.nl_loss_recoveries
  add column if not exists approval_status text not null default 'none',
  add column if not exists proposed_by uuid,
  add column if not exists proposed_by_name text,
  add column if not exists proposed_at timestamptz,
  add column if not exists approved_by uuid,
  add column if not exists approved_by_name text,
  add column if not exists approved_at timestamptz,
  add column if not exists approval_note text not null default '';

do $$ begin
  alter table public.nl_loss_recoveries drop constraint if exists nl_loss_recovery_approval_check;
  alter table public.nl_loss_recoveries add constraint nl_loss_recovery_approval_check check (
    approval_status in ('none','proposed','approved','returned','needs_review')
  );
exception when others then null;
end $$;

-- ─── 3. Clarifications (station / associate; reuse Cloak disputes for live NL where possible) ─
create table if not exists public.nl_loss_clarifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  month text not null,
  case_key text not null,
  employee_ref text,
  category text not null default 'clarification',
  reason text not null default '',
  note text not null,
  evidence_url text,
  attachments jsonb not null default '[]',
  status text not null default 'submitted'
    check (status in ('submitted','returned','resolved','withdrawn')),
  source text not null default 'station'
    check (source in ('station','associate','cluster')),
  version int not null default 1,
  raised_by uuid not null,
  raised_by_name text not null,
  decided_by uuid,
  decided_by_name text,
  decision_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, month, case_key)
    references public.nl_loss_month_cases(company_id, month, case_key)
);
create index if not exists nl_loss_clarifications_case_idx
  on public.nl_loss_clarifications(company_id, month, case_key, status, created_at desc);

create table if not exists public.nl_loss_clarification_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  clarification_id uuid not null references public.nl_loss_clarifications(id),
  action text not null,
  from_status text,
  to_status text not null,
  actor_id uuid,
  actor_name text,
  note text not null default '',
  created_at timestamptz not null default now()
);
create or replace function public.nl_loss_clarification_events_immutable() returns trigger
language plpgsql set search_path=public as $$
begin raise exception 'Clarification history cannot be changed.'; end $$;
drop trigger if exists nl_loss_clarification_events_immutable on public.nl_loss_clarification_events;
create trigger nl_loss_clarification_events_immutable
  before update or delete on public.nl_loss_clarification_events
  for each row execute function public.nl_loss_clarification_events_immutable();

alter table public.nl_loss_clarifications enable row level security;
alter table public.nl_loss_clarification_events enable row level security;
revoke all on public.nl_loss_clarifications, public.nl_loss_clarification_events from public, anon, authenticated;
grant all on public.nl_loss_clarifications to service_role;
grant select, insert on public.nl_loss_clarification_events to service_role;

-- ─── 4. Defaults for new cases (INSERT only; never reset in-flight workflows) ─
create or replace function public.nl_loss_case_lifecycle_defaults()
returns trigger language plpgsql set search_path=public as $$
begin
  if tg_op = 'INSERT' then
    if new.lifecycle_status is null or new.lifecycle_status = 'imported' then
      new.lifecycle_status := case
        when new.report = 'nl' and coalesce(new.data_source, 'live') = 'live'
          then 'station_dispute_or_clarification_window'
        when new.report = 'slp'
          and new.final_seen_at is null
          and not coalesce((new.details->>'in_final')::boolean, false)
          then 'imported'
        when public.nl_case_recoverable(new.company_id, new.report, new.source_status)
          then 'cluster_validation_pending'
        else 'not_recoverable'
      end;
    end if;
    new.lifecycle_updated_at := coalesce(new.lifecycle_updated_at, now());
    return new;
  end if;
  -- Source became non-recoverable before an approved plan: close the workflow.
  if not public.nl_case_recoverable(new.company_id, new.report, new.source_status)
     and old.lifecycle_status in (
       'imported','station_dispute_or_clarification_window','cluster_validation_pending',
       'returned_to_station','slp_final_confirmation_pending'
     ) then
    new.lifecycle_status := 'not_recoverable';
    new.lifecycle_version := old.lifecycle_version + 1;
    new.lifecycle_updated_at := now();
  end if;
  -- Amount/status drift after a locked plan → needs_review (payroll history stays).
  if old.lifecycle_status in ('recovery_approved_scheduled','recovery_in_progress','slp_final_confirmation_pending')
     and (
       round(coalesce(old.amount,0),2) is distinct from round(coalesce(new.amount,0),2)
       or (new.report <> 'slp' and old.source_status is distinct from new.source_status)
     ) then
    new.lifecycle_status := 'needs_review';
    new.lifecycle_version := old.lifecycle_version + 1;
    new.lifecycle_updated_at := now();
  end if;
  -- Preserve final_seen_at semantics from earlier migrations.
  if new.report = 'slp' and new.final_seen_at is null
     and coalesce((new.details->>'in_final')::boolean, false) then
    new.final_seen_at := now();
  end if;
  if tg_op = 'UPDATE' then
    new.final_seen_at := coalesce(old.final_seen_at, new.final_seen_at);
  end if;
  return new;
end $$;

drop trigger if exists nl_loss_case_lifecycle_defaults on public.nl_loss_month_cases;
create trigger nl_loss_case_lifecycle_defaults
  before insert or update on public.nl_loss_month_cases
  for each row execute function public.nl_loss_case_lifecycle_defaults();

-- ─── 5. Case transition (versioned; app still checks who may call) ────────────
create or replace function public.nl_loss_lifecycle_transition(
  p_company uuid, p_month text, p_case text, p_action text, p_version int,
  p_actor uuid, p_name text, p_note text default null
) returns public.nl_loss_month_cases
language plpgsql security invoker set search_path=public as $$
declare
  c public.nl_loss_month_cases;
  target text;
  note text := nullif(btrim(coalesce(p_note,'')), '');
  saved public.nl_loss_month_cases;
begin
  select * into c from public.nl_loss_month_cases
   where company_id = p_company and month = p_month and case_key = p_case for update;
  if not found or not c.source_present then
    raise exception 'This case is no longer available. Refresh the list.';
  end if;
  if c.lifecycle_version <> p_version then
    raise exception 'Someone else updated this case. Refresh and try again.';
  end if;
  if note is not null and length(note) > 2000 then
    raise exception 'Keep the note under 2,000 characters.';
  end if;

  target := case
    when p_action = 'open_station_window' and c.lifecycle_status = 'imported'
      then 'station_dispute_or_clarification_window'
    when p_action = 'ready_for_cluster'
      and c.lifecycle_status in ('imported','station_dispute_or_clarification_window','returned_to_station')
      then 'cluster_validation_pending'
    when p_action = 'return_to_station'
      and c.lifecycle_status in ('cluster_validation_pending','slp_final_confirmation_pending','needs_review')
      then 'returned_to_station'
    when p_action = 'reject'
      and c.lifecycle_status in ('cluster_validation_pending','slp_final_confirmation_pending','needs_review','returned_to_station')
      then 'rejected'
    when p_action = 'hold'
      and c.lifecycle_status in (
        'cluster_validation_pending','slp_final_confirmation_pending',
        'recovery_approved_scheduled','needs_review'
      ) then 'on_hold'
    when p_action = 'resume' and c.lifecycle_status = 'on_hold'
      then coalesce(
        (
          select case
            when r.approval_status = 'approved' and r.deduction_timing <> 'none'
              then 'recovery_approved_scheduled'
            when r.approval_status = 'needs_review' then 'needs_review'
            when r.approval_status = 'proposed' then 'slp_final_confirmation_pending'
            when r.approval_status = 'returned' then 'returned_to_station'
            else 'cluster_validation_pending'
          end
          from public.nl_loss_recoveries r
          where r.company_id = c.company_id
            and r.month = c.month
            and r.case_key = c.case_key
            and not r.is_deleted
          limit 1
        ),
        'cluster_validation_pending'
      )
    when p_action = 'mark_needs_review'
      and c.lifecycle_status in (
        'cluster_validation_pending','slp_final_confirmation_pending',
        'recovery_approved_scheduled','recovery_in_progress'
      ) then 'needs_review'
    when p_action = 'clear_needs_review' and c.lifecycle_status = 'needs_review'
      then 'cluster_validation_pending'
    else null
  end;

  if target is null then
    raise exception 'This case is %, so it cannot be changed this way. Refresh to see its latest state.',
      c.lifecycle_status;
  end if;
  if p_action in ('return_to_station','reject','hold','mark_needs_review')
     and (note is null or length(note) < 5) then
    raise exception 'Add a reason (at least 5 characters).';
  end if;

  update public.nl_loss_month_cases set
    lifecycle_status = target,
    lifecycle_version = lifecycle_version + 1,
    lifecycle_note = coalesce(note, ''),
    lifecycle_updated_by = p_actor,
    lifecycle_updated_by_name = p_name,
    lifecycle_updated_at = now()
  where company_id = p_company and month = p_month and case_key = p_case
  returning * into saved;

  if p_action in ('return_to_station','reject','mark_needs_review') then
    update public.nl_loss_recoveries set
      approval_status = case
        when p_action = 'mark_needs_review' then 'needs_review'
        when p_action = 'return_to_station' then 'returned'
        else approval_status end,
      approval_note = coalesce(note, approval_note),
      version = version + 1,
      updated_at = now()
    where company_id = p_company and month = p_month and case_key = p_case
      and not is_deleted and approval_status in ('proposed','approved','needs_review','returned');
  end if;

  insert into public.nl_loss_lifecycle_events(
    company_id, month, case_key, action, from_status, to_status, note, actor_id, actor_name, snapshot
  ) values (
    p_company, p_month, p_case, p_action, c.lifecycle_status, target, coalesce(note,''),
    p_actor, p_name, to_jsonb(saved)
  );

  -- Resume of an approved plan restores the scheduled state; sync may advance to in_progress.
  if p_action = 'resume' and saved.lifecycle_status = 'recovery_approved_scheduled' then
    perform public.nl_loss_lifecycle_sync(p_company, p_month, p_case);
    select * into saved from public.nl_loss_month_cases
     where company_id = p_company and month = p_month and case_key = p_case;
  end if;
  return saved;
end $$;

-- ─── 6. SLP final approval (cannot approve own proposal) ─────────────────────
create or replace function public.nl_loss_recovery_approve(
  p_company uuid, p_month text, p_case text, p_version int,
  p_actor uuid, p_name text, p_note text default null, p_lifecycle_version int default null
) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare
  c public.nl_loss_month_cases;
  r public.nl_loss_recoveries;
  note text := nullif(btrim(coalesce(p_note,'')), '');
  saved public.nl_loss_recoveries;
begin
  perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text, 0));
  select * into c from public.nl_loss_month_cases
   where company_id = p_company and month = p_month and case_key = p_case for update;
  if not found or not c.source_present then
    raise exception 'This case is no longer available. Refresh the list.';
  end if;
  if p_lifecycle_version is not null and c.lifecycle_version <> p_lifecycle_version then
    raise exception 'Someone else updated this case. Refresh and try again.';
  end if;
  if c.lifecycle_status not in ('slp_final_confirmation_pending','needs_review') then
    raise exception 'This case is %, so it is not waiting for SLP final confirmation.', c.lifecycle_status;
  end if;
  if not public.nl_case_recoverable(p_company, c.report, c.source_status) then
    raise exception 'This case is no longer recoverable at source.';
  end if;
  if c.report = 'slp' and c.final_seen_at is null then
    raise exception 'SLP Initial is read-only. Approve recovery only after SLP Final.';
  end if;
  select * into r from public.nl_loss_recoveries
   where company_id = p_company and month = p_month and case_key = p_case for update;
  if not found or r.is_deleted then
    raise exception 'There is no recovery proposal to approve.';
  end if;
  if r.version <> p_version then
    raise exception 'Someone else updated this recovery. Refresh and try again.';
  end if;
  if r.approval_status not in ('proposed','needs_review') then
    raise exception 'This recovery is %, so it cannot be approved this way.', r.approval_status;
  end if;
  if r.deduction_timing <> 'none' and r.proposed_by is not null and r.proposed_by = p_actor then
    raise exception 'You proposed this recovery, so another authorised person must approve it.';
  end if;
  if round(c.amount, 2) is distinct from round(r.source_amount, 2) then
    raise exception 'The imported loss amount changed. Return the plan for re-proposal.';
  end if;
  if note is not null and length(note) > 2000 then
    raise exception 'Keep the note under 2,000 characters.';
  end if;

  update public.nl_loss_recoveries set
    approval_status = 'approved',
    approved_by = p_actor,
    approved_by_name = p_name,
    approved_at = now(),
    approval_note = coalesce(note, ''),
    version = version + 1,
    updated_by = p_actor,
    updated_by_name = p_name,
    updated_at = now()
  where company_id = p_company and month = p_month and case_key = p_case
  returning * into saved;

  update public.nl_loss_month_cases set
    lifecycle_status = 'recovery_approved_scheduled',
    lifecycle_version = lifecycle_version + 1,
    lifecycle_note = coalesce(note, ''),
    lifecycle_updated_by = p_actor,
    lifecycle_updated_by_name = p_name,
    lifecycle_updated_at = now()
  where company_id = p_company and month = p_month and case_key = p_case;

  insert into public.nl_loss_lifecycle_events(
    company_id, month, case_key, action, from_status, to_status, note, actor_id, actor_name, snapshot
  ) values (
    p_company, p_month, p_case, 'approve_recovery', c.lifecycle_status, 'recovery_approved_scheduled',
    coalesce(note,''), p_actor, p_name, to_jsonb(saved)
  );
  insert into public.nl_loss_recovery_events(company_id, month, case_key, before_value, after_value, actor_id, actor_name)
  values (p_company, p_month, p_case, to_jsonb(r), to_jsonb(saved), p_actor, p_name);

  if exists(select 1 from jsonb_array_elements(saved.allocations) x where x->>'ref' like 'workforce:%') then
    perform public.nl_recovery_bump_payout_months(p_company, array[saved.deduction_month]);
  end if;
  return to_jsonb(saved);
end $$;

-- ─── 7. Clarification submit / resolve ───────────────────────────────────────
create or replace function public.nl_loss_clarification_submit(
  p_company uuid, p_month text, p_case text, p_actor uuid, p_name text,
  p_note text, p_reason text default '', p_category text default 'clarification',
  p_employee_ref text default null, p_evidence_url text default null,
  p_attachments jsonb default '[]', p_source text default 'station'
) returns public.nl_loss_clarifications
language plpgsql security invoker set search_path=public as $$
declare
  c public.nl_loss_month_cases;
  saved public.nl_loss_clarifications;
  note text := btrim(coalesce(p_note,''));
begin
  select * into c from public.nl_loss_month_cases
   where company_id = p_company and month = p_month and case_key = p_case for update;
  if not found or not c.source_present then
    raise exception 'This case is no longer available.';
  end if;
  if length(note) < 10 or length(note) > 4000 then
    raise exception 'Explain the clarification (10–4,000 characters).';
  end if;
  if p_source not in ('station','associate','cluster') then
    raise exception 'Invalid clarification source.';
  end if;
  if nullif(btrim(coalesce(p_evidence_url,'')),'') is not null
     and btrim(p_evidence_url) !~ '^https://[^[:space:]]+$' then
    raise exception 'Evidence must be an https:// link.';
  end if;

  insert into public.nl_loss_clarifications(
    company_id, month, case_key, employee_ref, category, reason, note, evidence_url,
    attachments, status, source, raised_by, raised_by_name
  ) values (
    p_company, p_month, p_case, nullif(btrim(coalesce(p_employee_ref,'')),''),
    coalesce(nullif(btrim(p_category),''),'clarification'),
    btrim(coalesce(p_reason,'')), note,
    nullif(btrim(coalesce(p_evidence_url,'')),''),
    coalesce(p_attachments,'[]'::jsonb), 'submitted', p_source, p_actor, p_name
  ) returning * into saved;

  insert into public.nl_loss_clarification_events(
    company_id, clarification_id, action, to_status, actor_id, actor_name, note
  ) values (p_company, saved.id, 'submit', 'submitted', p_actor, p_name, note);

  -- Pause only future recovery; never mutate reviewed payroll / published payout.
  if c.lifecycle_status in (
    'recovery_approved_scheduled','recovery_in_progress','slp_final_confirmation_pending','cluster_validation_pending'
  ) then
    update public.nl_loss_month_cases set
      lifecycle_status = 'needs_review',
      lifecycle_version = lifecycle_version + 1,
      lifecycle_note = left('Clarification: '||note, 2000),
      lifecycle_updated_by = p_actor,
      lifecycle_updated_by_name = p_name,
      lifecycle_updated_at = now()
    where company_id = p_company and month = p_month and case_key = p_case;
    update public.nl_loss_recoveries set
      approval_status = case when approval_status = 'approved' then 'needs_review' else approval_status end,
      version = version + 1,
      updated_at = now()
    where company_id = p_company and month = p_month and case_key = p_case
      and not is_deleted and approval_status in ('proposed','approved');
    insert into public.nl_loss_lifecycle_events(
      company_id, month, case_key, action, from_status, to_status, note, actor_id, actor_name, snapshot
    ) values (
      p_company, p_month, p_case, 'clarification', c.lifecycle_status, 'needs_review',
      note, p_actor, p_name, to_jsonb(saved)
    );
  end if;
  return saved;
end $$;

create or replace function public.nl_loss_clarification_resolve(
  p_company uuid, p_id uuid, p_action text, p_version int,
  p_actor uuid, p_name text, p_note text default null
) returns public.nl_loss_clarifications
language plpgsql security invoker set search_path=public as $$
declare
  q public.nl_loss_clarifications;
  target text;
  note text := nullif(btrim(coalesce(p_note,'')), '');
  saved public.nl_loss_clarifications;
begin
  select * into q from public.nl_loss_clarifications where company_id = p_company and id = p_id for update;
  if not found then raise exception 'Clarification was not found.'; end if;
  if q.version <> p_version then raise exception 'Someone else updated this clarification. Refresh.'; end if;
  target := case
    when p_action = 'return' and q.status = 'submitted' then 'returned'
    when p_action = 'resolve' and q.status in ('submitted','returned') then 'resolved'
    when p_action = 'withdraw' and q.status = 'submitted' and p_actor = q.raised_by then 'withdrawn'
  end;
  if target is null then
    raise exception 'This clarification is %, so it cannot be changed this way.', q.status;
  end if;
  if p_action in ('return','resolve') and (note is null or length(note) < 5) then
    raise exception 'Add a note (at least 5 characters).';
  end if;
  update public.nl_loss_clarifications set
    status = target, version = version + 1, updated_at = now(),
    decided_by = case when p_action = 'withdraw' then decided_by else p_actor end,
    decided_by_name = case when p_action = 'withdraw' then decided_by_name else p_name end,
    decision_note = coalesce(note, '')
  where id = p_id returning * into saved;
  insert into public.nl_loss_clarification_events(
    company_id, clarification_id, action, from_status, to_status, actor_id, actor_name, note
  ) values (p_company, p_id, p_action, q.status, target, p_actor, p_name, coalesce(note,''));
  return saved;
end $$;

-- ─── 8. Sync terminal lifecycle from ledger (after deductions / write-off) ────
create or replace function public.nl_loss_lifecycle_sync(p_company uuid, p_month text, p_case text)
returns text language plpgsql security invoker set search_path=public as $$
declare
  c public.nl_loss_month_cases;
  r public.nl_loss_recoveries;
  all_recovered boolean;
  any_progress boolean;
  any_exit boolean;
  any_waived boolean;
  target text;
begin
  select * into c from public.nl_loss_month_cases
   where company_id = p_company and month = p_month and case_key = p_case for update;
  if not found then return null; end if;
  select * into r from public.nl_loss_recoveries
   where company_id = p_company and month = p_month and case_key = p_case and not is_deleted;
  if not found or r.approval_status <> 'approved' or r.deduction_timing = 'none' then
    return c.lifecycle_status;
  end if;
  if c.lifecycle_status in ('rejected','not_recoverable','on_hold','returned_to_station') then
    return c.lifecycle_status;
  end if;

  select
    bool_and(l.status in ('recovered','written_off')),
    bool_or(l.status in ('in_progress','recovered','written_off','exit_balance')),
    bool_or(l.status = 'exit_balance'),
    bool_or(l.status = 'written_off')
  into all_recovered, any_progress, any_exit, any_waived
  from public.nl_recovery_ledger(p_company, p_month, null) l
  where l.month = p_month and l.case_key = p_case;

  target := case
    when coalesce(all_recovered, false) and coalesce(any_waived, false) and not coalesce(any_progress, false)
      then 'written_off'
    when coalesce(all_recovered, false) then 'recovered'
    when coalesce(any_exit, false) then 'exit_balance'
    when coalesce(any_progress, false) then 'recovery_in_progress'
    when c.lifecycle_status = 'needs_review' then 'needs_review'
    else 'recovery_approved_scheduled'
  end;

  if target is distinct from c.lifecycle_status then
    update public.nl_loss_month_cases set
      lifecycle_status = target,
      lifecycle_version = lifecycle_version + 1,
      lifecycle_updated_at = now()
    where company_id = p_company and month = p_month and case_key = p_case;
    insert into public.nl_loss_lifecycle_events(
      company_id, month, case_key, action, from_status, to_status, note, actor_name, snapshot
    ) values (
      p_company, p_month, p_case, 'sync_ledger', c.lifecycle_status, target, '', 'system',
      jsonb_build_object('all_recovered', all_recovered, 'any_progress', any_progress)
    );
  end if;
  return target;
end $$;

-- ─── 9. Payroll due: only approved, not held / rejected / needs_review ───────
create or replace function public.nl_loss_recovery_due(
  p_company uuid, p_salary_month text, p_target text, p_run_id uuid default null
) returns table(
  recovery_key text, month text, case_key text, report text, employee_ref text, worker_id uuid,
  employee_code text, full_name text, amount numeric, deduction_month text, label text,
  installment_no int, installment_count int, cap_exempt boolean, cap_percent numeric, final_settlement boolean
) language sql stable security invoker set search_path=public as $$
 with policy as (
  select coalesce(s.recovery_policy->>'payroll_start_month','2026-10') start_month,
   case when coalesce((s.recovery_policy->>'salary_cap_enabled')::boolean,false)
     then least(100,greatest(1,coalesce((s.recovery_policy->>'salary_cap_percent')::numeric,100)))
     else 100 end cap_percent
  from nl_loss_sources s where s.company_id=p_company limit 1),
 bounds as (
  select (to_date(p_salary_month,'YYYY-MM')+interval '1 month'-interval '1 day')::date last_day,
   case when p_target='workforce' then to_date(p_salary_month,'YYYY-MM') end excluded_period
  where p_salary_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 allocs as (
  select r.month, r.case_key, c.report, r.deduction_month, r.cap_override, x alloc, x->>'ref' employee_ref,
   nl_recovery_person_exit(p_company,x->>'ref') exit_date,
   upper(c.report)||' loss · '||to_char(to_date(r.month,'YYYY-MM'),'Mon YYYY')||' · '||regexp_replace(r.case_key,'^slp:','') base_label
  from nl_loss_recoveries r
  join nl_loss_month_cases c on c.company_id=r.company_id and c.month=r.month and c.case_key=r.case_key
  cross join jsonb_array_elements(r.allocations) x
  cross join policy cross join bounds
  where p_salary_month>=policy.start_month
   and r.company_id=p_company and not r.is_deleted and r.deduction_timing<>'none' and r.deduction_month is not null
   and r.approval_status = 'approved'
   and c.lifecycle_status in ('recovery_approved_scheduled','recovery_in_progress','exit_balance')
   and greatest(r.deduction_month,policy.start_month)<=p_salary_month
   and split_part(x->>'ref',':',1)=case p_target when 'hrms' then 'employee' when 'workforce' then 'workforce' end
   and coalesce((x->>'amount')::numeric,0)>0
   and c.source_present and round(c.amount,2)=round(r.source_amount,2)
   and nl_case_recoverable(p_company,c.report,c.source_status)
   and (c.report<>'slp' or c.final_seen_at is not null)
   and not exists(select 1 from nl_recovery_waivers w
     where w.company_id=r.company_id and w.month=r.month and w.case_key=r.case_key and w.employee_ref=x->>'ref')),
 lines as (
  select k.recovery_key, a.month, a.case_key, a.report, a.employee_ref, split_part(a.employee_ref,':',2)::uuid worker_id,
   a.alloc->>'employee_code' employee_code, a.alloc->>'full_name' full_name, k.amount, a.deduction_month,
   k.installment_no, nullif(jsonb_array_length(coalesce(a.alloc->'installments','[]')),0) installment_count,
   a.exit_date is not null and a.exit_date<=b.last_day final_settlement, a.cap_override, a.base_label,
   nl_recovery_key(a.month,a.case_key,a.employee_ref) base_key, b.excluded_period
  from allocs a cross join bounds b cross join lateral nl_recovery_alloc_keys(a.month,a.case_key,a.alloc) k
  where k.amount>0)
 select l.recovery_key, l.month, l.case_key, l.report, l.employee_ref, l.worker_id, l.employee_code, l.full_name, l.amount, l.deduction_month,
  l.base_label||case when l.installment_no is not null then ' · instalment '||l.installment_no||' of '||l.installment_count else '' end
   ||case when l.final_settlement then ' · final settlement' else '' end,
  l.installment_no, l.installment_count, l.cap_override or l.final_settlement, p.cap_percent, l.final_settlement
 from lines l cross join policy p
 where nl_recovery_line_applied(p_company,l.recovery_key,p_run_id,l.excluded_period) is null
  and (l.installment_no is null or l.installment_no=1 or l.final_settlement
   or nl_recovery_line_applied(p_company,l.base_key||'|'||(l.installment_no-1),p_run_id,l.excluded_period)<p_salary_month)
 order by l.deduction_month,l.month,l.case_key,l.employee_ref,l.installment_no nulls first
$$;

-- ─── 10. save_nl_recovery: allocating plan becomes a proposal (not yet due) ───
create or replace function public.save_nl_recovery(
  p_company uuid, p_month text, p_case text, p_version int, p_outcome text, p_mode text,
  p_allocations jsonb, p_remarks text, p_actor uuid, p_name text,
  p_details jsonb default '{}', p_plan jsonb default '{}'
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare
  c nl_loss_month_cases; o nl_recovery_outcomes; old nl_loss_recoveries; saved nl_loss_recoveries;
  a jsonb; people jsonb:='[]'; person jsonb; station uuid; total bigint:=0; expected bigint; n int; i int:=0;
  amt bigint; deduction text; policy jsonb; settings_updated timestamptz; pay nl_recovery_payables;
  pay_month text; reserved numeric; cap numeric; attachment jsonb; assigned timestamptz; same_plan boolean;
  locked record;
  v_mode text:=coalesce(nullif(p_plan->>'mode',''),'full'); v_basis text:=nullif(p_plan->>'basis','');
  v_value numeric; v_override boolean:=coalesce((p_plan->>'cap_override')::boolean,false);
  v_override_reason text:=nullif(trim(coalesce(p_plan->>'cap_override_reason','')),'');
  max_k int; k int; per bigint; rem bigint; monthly bigint; schedule jsonb; j int;
  v_approval text; next_lifecycle text;
begin
  perform pg_advisory_xact_lock(hashtextextended('nl-recovery:'||p_company::text,0));
  select recovery_policy,updated_at into policy,settings_updated from nl_loss_sources where company_id=p_company;
  max_k:=least(60,greatest(2,coalesce((policy->>'max_installments')::int,24)));
  pay_month:=to_char(date_trunc('month',now() at time zone 'Asia/Kolkata')-make_interval(months=>(policy->>'salary_month_offset')::int),'YYYY-MM');
  select * into c from nl_loss_month_cases where company_id=p_company and month=p_month and case_key=p_case for update;
  if not found or not c.source_present or not nl_case_recoverable(p_company,c.report,c.source_status) then
    raise exception 'This case is no longer recoverable at source. Refresh the list.';
  end if;
  if c.lifecycle_status in ('rejected','not_recoverable','written_off','recovered','on_hold') then
    raise exception 'This case is %, so a recovery plan cannot be saved.', c.lifecycle_status;
  end if;
  select * into o from nl_recovery_outcomes where company_id=p_company and code=p_outcome and is_active;
  if not found then raise exception 'Choose an active outcome from Loss Recovery Master.'; end if;
  if p_remarks is null or length(trim(p_remarks))>2000 or (o.remarks_required and length(trim(p_remarks))<5) then
    raise exception 'Add a clear recovery remark (5–2,000 characters).';
  end if;
  if not o.allocation_required then v_mode:='full'; v_basis:=null; v_override:=false; v_override_reason:=null; end if;
  if v_mode not in ('full','installments') then raise exception 'Choose Full debit or Recurring debit.'; end if;
  if v_mode='installments' then
    if coalesce(v_basis,'') not in ('months','amount') then
      raise exception 'Choose instalments by number of months or by amount per month.';
    end if;
    if coalesce(p_plan->>'value','') !~ '^\d+(\.\d{1,2})?$' then
      raise exception 'Enter the number of months or the monthly amount.';
    end if;
    v_value:=(p_plan->>'value')::numeric;
    if v_basis='months' and (v_value<>trunc(v_value) or v_value<2 or v_value>max_k) then
      raise exception 'Instalments must be between 2 and % months.',max_k;
    end if;
    if v_basis='amount' and v_value<1 then raise exception 'The monthly amount must be at least ₹1.'; end if;
  else
    v_basis:=null; v_value:=null;
  end if;
  if v_override and (v_override_reason is null or length(v_override_reason)<10 or length(v_override_reason)>500) then
    raise exception 'Give a reason for recovering beyond the salary cap (10–500 characters).';
  end if;
  if not v_override then v_override_reason:=null; end if;
  if o.dispute_fields_enabled then
    if o.reason_required and length(trim(coalesce(p_details->>'reason','')))<5 then
      raise exception 'Reason for re-dispute is required (at least 5 characters).';
    end if;
    if o.details_required and length(trim(coalesce(p_details->>'details','')))<5 then
      raise exception 'Detailing is required (at least 5 characters).';
    end if;
    if length(coalesce(p_details->>'reason',''))>2000 or length(coalesce(p_details->>'details',''))>10000 then
      raise exception 'Re-dispute text is too long.';
    end if;
    if nullif(p_details->>'cctv_url','') is not null then
      if not o.cctv_enabled or (p_details->>'cctv_url') !~ '^https://[^[:space:]]+$' then
        raise exception 'Enter a valid HTTPS CCTV link.';
      end if;
      if (policy->>'cctv_public_confirmation')::boolean
         and coalesce((p_details->>'cctv_public_confirmed')::boolean,false)=false then
        raise exception 'Confirm CCTV sharing is set to anyone with the link can view.';
      end if;
    end if;
    if jsonb_typeof(coalesce(p_details->'attachments','[]'))<>'array'
       or jsonb_array_length(coalesce(p_details->'attachments','[]'))>(policy->>'attachment_max_count')::int then
      raise exception 'Too many attachments.';
    end if;
    for attachment in select value from jsonb_array_elements(coalesce(p_details->'attachments','[]')) loop
      if not o.attachments_enabled or not exists(
        select 1 from nl_recovery_attachments f
        where f.company_id=p_company and f.month=p_month and f.case_key=p_case and f.id::text=attachment->>'id'
      ) then raise exception 'Attachment is not linked to this case.'; end if;
    end loop;
  else
    p_details:='{}';
  end if;
  select * into old from nl_loss_recoveries where company_id=p_company and month=p_month and case_key=p_case;
  if coalesce(old.version,0)<>p_version then
    raise exception 'Another person updated this recovery. Refresh before saving.';
  end if;
  -- After any reviewed/published deduction, structural edits stay locked (existing rule).
  if old.approval_status = 'approved' and exists(
    select 1 from nl_recovery_locked_lines(p_company,p_month,p_case)
  ) and o.allocation_required then
    -- Allow remarks-only when same_plan; structural change raises below via locked_lines.
    null;
  elsif o.allocation_required and c.lifecycle_status not in (
    'cluster_validation_pending','returned_to_station','needs_review',
    'slp_final_confirmation_pending','station_dispute_or_clarification_window','imported'
  ) and coalesce(old.approval_status,'none') not in ('proposed','returned','needs_review','none') then
    if c.lifecycle_status not in ('recovery_approved_scheduled','recovery_in_progress') then
      raise exception 'This case is %, so a new recovery proposal cannot be saved.', c.lifecycle_status;
    end if;
  end if;

  if jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations)>50 then
    raise exception 'Select up to 50 employees.';
  end if;
  select s.id into station from stations s
   left join cod_station_settings x on x.location_id=s.id and x.company_id=p_company
   where s.company_id=p_company
     and upper(coalesce(nullif(x.portal_station_code,''),s.station_code))=upper(c.station_code)
   order by (s.station_code=c.station_code) desc limit 1;
  if station is null then raise exception 'Map the source station before allocating recovery.'; end if;

  if o.allocation_required then
    if c.report='slp' and c.final_seen_at is null then
      raise exception 'This SLP case is still in SLP Initial. Assign employees once it is in the SLP Final file.';
    end if;
    if not exists(select 1 from nl_loss_sources where company_id=p_company
      and ((p_mode='equal' and allow_equal_split) or (p_mode='custom' and allow_custom_split))) then
      raise exception 'This split method is disabled in Master.';
    end if;
    n:=jsonb_array_length(p_allocations); expected:=round(c.amount*100);
    if n<1 or expected is null or expected<=0 or p_mode not in ('equal','custom') then
      raise exception 'Select employees and a valid split for the full loss value.';
    end if;
    if (select count(distinct x->>'employee_ref') from jsonb_array_elements(p_allocations)x)<>n then
      raise exception 'An employee can only be selected once.';
    end if;
    for a in select value from jsonb_array_elements(p_allocations) loop
      select to_jsonb(d) into person from station_audit_employee_directory(p_company,station)d
       where d.ref=a->>'employee_ref';
      if not coalesce((person->>'is_active')::boolean,false)
         and not exists(select 1 from nl_loss_sources where company_id=p_company and include_inactive_people) then
        raise exception 'Inactive employees are disabled in Master.';
      end if;
      if person is null then raise exception 'Selected employee is not linked to this station.'; end if;
      if nullif(trim(person->>'employee_code'),'') is null then
        raise exception 'Every selected employee must have a valid employee ID.';
      end if;
      if p_mode='equal' then amt:=expected/n+case when i<expected%n then 1 else 0 end;
      else
        if coalesce(a->>'amount','') !~ '^\d+(\.\d{1,2})?$' then
          raise exception 'Enter amounts with at most two decimal places.';
        end if;
        amt:=((a->>'amount')::numeric*100)::bigint;
      end if;
      if amt<=0 then raise exception 'Every selected employee must have a positive amount.'; end if;
      schedule:='[]';
      if v_mode='installments' then
        if v_basis='months' then
          k:=v_value::int;
          if amt<k*100 then
            raise exception 'The share of % is too small for % instalments. Use fewer months or Full debit.',
              person->>'employee_code',k;
          end if;
          per:=amt/k; rem:=amt%k;
          for j in 1..k loop
            schedule:=schedule||jsonb_build_array(jsonb_build_object(
              'n',j,'amount',round((per+case when j<=rem then 1 else 0 end)::numeric/100,2)));
          end loop;
        else
          per:=round(v_value*100)::bigint;
          if per>=amt then
            raise exception 'The monthly amount covers the whole share of %. Use Full debit instead.',
              person->>'employee_code';
          end if;
          k:=((amt+per-1)/per)::int;
          if k>max_k then
            raise exception 'At ₹% a month the share of % needs % instalments; the maximum is %. Raise the monthly amount.',
              v_value,person->>'employee_code',k,max_k;
          end if;
          for j in 1..k loop
            schedule:=schedule||jsonb_build_array(jsonb_build_object(
              'n',j,'amount',round(least(per,amt-(j-1)*per)::numeric/100,2)));
          end loop;
        end if;
        monthly:=((schedule->0->>'amount')::numeric*100)::bigint;
      else
        monthly:=amt;
      end if;
      select * into pay from nl_recovery_payables q
       where q.company_id=p_company and q.employee_ref=a->>'employee_ref' and q.salary_month=pay_month
       for update;
      if not found or pay.checked_at<now()-interval '5 minutes'
         or pay.policy_updated_at is distinct from settings_updated then
        raise exception 'Refresh employee eligibility and salary payable before saving.';
      end if;
      if not pay.eligible then
        raise exception 'Selected employee does not meet the active-period rules in Master.';
      end if;
      if (policy->>'salary_cap_enabled')::boolean then
        if pay.payable is null then
          raise exception 'Previous-month salary payable is unavailable. Complete payroll or payout mapping first.';
        end if;
        reserved:=0;
        if (policy->>'reserve_other_recoveries')::boolean then
          select coalesce(sum(coalesce((x->>'monthly_amount')::numeric,(x->>'amount')::numeric)),0)
            into reserved
          from nl_loss_recoveries r cross join jsonb_array_elements(r.allocations)x
          where r.company_id=p_company and not r.is_deleted and not(r.month=p_month and r.case_key=p_case)
            and r.approval_status in ('proposed','approved')
            and x->>'ref'=a->>'employee_ref' and x->>'salary_month'=pay.salary_month;
        end if;
        cap:=greatest(0,round(pay.payable*(case when v_override then 100 else (policy->>'salary_cap_percent')::numeric end)/100,2)-reserved);
        if round(monthly::numeric/100,2)>cap then
          raise exception 'The monthly recovery of ₹% for % is more than the % salary limit of ₹%. Spread it over more instalments%.',
            round(monthly::numeric/100,2),person->>'employee_code',
            case when v_override then 'take-home' else (policy->>'salary_cap_percent')||'%' end,cap,
            case when v_override then '' else ', or record a cap override' end;
        end if;
      end if;
      if pay.gross is not null and round(monthly::numeric/100,2)>pay.gross then
        raise exception 'The monthly recovery for % is more than their gross pay of ₹%.',
          person->>'employee_code',pay.gross;
      end if;
      person:=person||jsonb_build_object(
        'salary_month',pay.salary_month,'salary_payable',pay.payable,'salary_gross',pay.gross,'salary_source',pay.source);
      total:=total+amt; i:=i+1;
      person:=person||jsonb_build_object('amount',round(amt::numeric/100,2),'monthly_amount',round(monthly::numeric/100,2));
      if v_mode='installments' then person:=person||jsonb_build_object('installments',schedule); end if;
      people:=people||jsonb_build_array(person);
    end loop;
    if total<>expected then
      raise exception 'Allocate the full loss value. Partial recovery is not allowed, including next-month exceptions.';
    end if;
  else
    if jsonb_array_length(p_allocations)>0 or p_mode<>'none' then
      raise exception 'This outcome does not allocate employee recovery.';
    end if;
  end if;

  same_plan:=coalesce(old.version is not null and not old.is_deleted and old.deduction_timing=o.deduction_timing
    and old.recovery_mode=v_mode and old.installment_basis is not distinct from v_basis
    and old.installment_value is not distinct from v_value
    and (select coalesce(jsonb_agg(jsonb_build_array(x->>'ref',(x->>'amount')::numeric) order by x->>'ref'),'[]')
         from jsonb_array_elements(old.allocations) x)
     =(select coalesce(jsonb_agg(jsonb_build_array(x->>'ref',(x->>'amount')::numeric) order by x->>'ref'),'[]')
         from jsonb_array_elements(people) x),false);

  if not same_plan and old.version is not null and not old.is_deleted then
    for locked in select * from nl_recovery_locked_lines(p_company,p_month,p_case) l loop
      if not exists(
        select 1 from jsonb_array_elements(people) x
        join jsonb_array_elements(old.allocations) y on y->>'ref'=x->>'ref'
        where x->>'ref'=locked.employee_ref and (x->>'amount')::numeric=(y->>'amount')::numeric
      ) or old.deduction_timing<>o.deduction_timing
        or old.recovery_mode<>v_mode or old.installment_basis is distinct from v_basis
        or old.installment_value is distinct from v_value then
        raise exception 'This recovery was already deducted in % payroll for %. Keep that person, amount and schedule, or settle the difference in payroll.',
          to_char(to_date(locked.applied_in,'YYYY-MM'),'FMMonth YYYY'),
          coalesce((select y->>'employee_code' from jsonb_array_elements(old.allocations) y
            where y->>'ref'=locked.employee_ref),locked.employee_ref);
      end if;
    end loop;
  end if;

  if o.deduction_timing<>'none' then
    assigned:=case when same_plan then coalesce(old.assigned_at,old.updated_at) else now() end;
    deduction:=case when same_plan and old.deduction_month is not null then old.deduction_month
      else nl_recovery_deduction_month(c.report,c.month,assigned,c.final_seen_at,o.deduction_timing,
        coalesce((policy->>'payroll_cutoff_day')::int,7)) end;
  end if;

  -- Allocating plans require SLP approval before they are due. Non-deduct outcomes do not.
  if o.allocation_required and o.deduction_timing<>'none' then
    if same_plan and old.approval_status = 'approved'
       and not exists(select 1 from nl_recovery_locked_lines(p_company,p_month,p_case)) then
      -- Remark-only edit of an unlocked approved plan keeps approval but still needs re-approval
      -- only when structure changes (same_plan ⇒ keep approved).
      v_approval := 'approved';
      next_lifecycle := c.lifecycle_status;
    elsif same_plan and old.approval_status = 'approved'
       and exists(select 1 from nl_recovery_locked_lines(p_company,p_month,p_case)) then
      v_approval := 'approved';
      next_lifecycle := c.lifecycle_status;
    else
      v_approval := 'proposed';
      next_lifecycle := 'slp_final_confirmation_pending';
    end if;
  else
    v_approval := 'none';
    next_lifecycle := case
      when o.code = 'already_recovered' then 'recovered'
      when o.deduction_timing = 'none' then 'not_recoverable'
      else c.lifecycle_status end;
  end if;

  insert into nl_loss_recoveries(
    company_id,month,case_key,outcome_code,outcome_label,split_mode,allocations,remarks,
    source_amount,source_status,version,updated_by,updated_by_name,deduction_timing,deduction_month,
    recovery_details,assigned_at,recovery_mode,installment_basis,installment_value,cap_override,
    cap_override_reason,approval_status,proposed_by,proposed_by_name,proposed_at,
    approved_by,approved_by_name,approved_at,approval_note
  ) values (
    p_company,p_month,p_case,o.code,o.label,p_mode,people,trim(p_remarks),c.amount,c.source_status,
    p_version+1,p_actor,p_name,o.deduction_timing,deduction,p_details,assigned,v_mode,v_basis,v_value,
    v_override,v_override_reason,v_approval,
    case when v_approval='proposed' then p_actor else old.proposed_by end,
    case when v_approval='proposed' then p_name else old.proposed_by_name end,
    case when v_approval='proposed' then now() else old.proposed_at end,
    case when v_approval='approved' then old.approved_by else null end,
    case when v_approval='approved' then old.approved_by_name else null end,
    case when v_approval='approved' then old.approved_at else null end,
    case when v_approval='proposed' then '' else coalesce(old.approval_note,'') end
  )
  on conflict(company_id,month,case_key) do update set
    outcome_code=excluded.outcome_code,outcome_label=excluded.outcome_label,split_mode=excluded.split_mode,
    allocations=excluded.allocations,remarks=excluded.remarks,source_amount=excluded.source_amount,
    source_status=excluded.source_status,recovery_details=excluded.recovery_details,
    deduction_timing=excluded.deduction_timing,deduction_month=excluded.deduction_month,
    assigned_at=excluded.assigned_at,recovery_mode=excluded.recovery_mode,
    installment_basis=excluded.installment_basis,installment_value=excluded.installment_value,
    cap_override=excluded.cap_override,cap_override_reason=excluded.cap_override_reason,
    approval_status=excluded.approval_status,proposed_by=excluded.proposed_by,
    proposed_by_name=excluded.proposed_by_name,proposed_at=excluded.proposed_at,
    approved_by=excluded.approved_by,approved_by_name=excluded.approved_by_name,
    approved_at=excluded.approved_at,approval_note=excluded.approval_note,
    is_deleted=false,version=excluded.version,updated_by=excluded.updated_by,
    updated_by_name=excluded.updated_by_name,updated_at=now()
  returning * into saved;

  if next_lifecycle is distinct from c.lifecycle_status then
    update nl_loss_month_cases set
      lifecycle_status = next_lifecycle,
      lifecycle_version = lifecycle_version + 1,
      lifecycle_updated_by = p_actor,
      lifecycle_updated_by_name = p_name,
      lifecycle_updated_at = now()
    where company_id=p_company and month=p_month and case_key=p_case;
    insert into nl_loss_lifecycle_events(
      company_id,month,case_key,action,from_status,to_status,note,actor_id,actor_name,snapshot
    ) values (
      p_company,p_month,p_case,
      case when v_approval='proposed' then 'propose_recovery' else 'save_recovery' end,
      c.lifecycle_status, next_lifecycle, trim(p_remarks), p_actor, p_name, to_jsonb(saved)
    );
  end if;

  insert into nl_loss_recovery_events(company_id,month,case_key,before_value,after_value,actor_id,actor_name)
  values(p_company,p_month,p_case,case when old.version is null then null else to_jsonb(old) end,to_jsonb(saved),p_actor,p_name);
  if exists(select 1 from jsonb_array_elements(coalesce(old.allocations,'[]')||saved.allocations) x
            where x->>'ref' like 'workforce:%') then
    perform nl_recovery_bump_payout_months(p_company,array[old.deduction_month,saved.deduction_month]);
  end if;
  return to_jsonb(saved);
end $$;

-- ─── 11. Command Center aggregate (bounded by station codes) ─────────────────
create or replace function public.nl_loss_recovery_command_summary(
  p_company uuid, p_stations text[], p_salary_month text default null
) returns jsonb language sql stable security invoker set search_path=public as $$
 with scoped as (
  select c.*, r.approval_status, r.deduction_month, r.deduction_timing, r.is_deleted,
         r.source_amount, r.allocations, r.cap_override
  from nl_loss_month_cases c
  left join nl_loss_recoveries r
    on r.company_id=c.company_id and r.month=c.month and r.case_key=c.case_key and not r.is_deleted
  where c.company_id=p_company and c.source_present
    and (p_stations is null or cardinality(p_stations)=0 or c.station_code = any(p_stations))
 ),
 recoverable as (
  select * from scoped s
  where nl_case_recoverable(p_company, s.report, s.source_status)
    and (s.report <> 'slp' or s.final_seen_at is not null)
 ),
 due_month as (
  select coalesce(nullif(p_salary_month,''),
    to_char(date_trunc('month', now() at time zone 'Asia/Kolkata'), 'YYYY-MM')) m
 )
 select jsonb_build_object(
  'total_recoverable', coalesce((select round(sum(amount),2) from recoverable),0),
  'awaiting_station', coalesce((select count(*)::int from recoverable
    where lifecycle_status in ('station_dispute_or_clarification_window','returned_to_station')),0),
  'awaiting_cluster', coalesce((select count(*)::int from recoverable
    where lifecycle_status in ('cluster_validation_pending','imported')),0),
  'awaiting_slp', coalesce((select count(*)::int from recoverable
    where lifecycle_status = 'slp_final_confirmation_pending'),0),
  'approved_not_scheduled', coalesce((select count(*)::int from recoverable
    where lifecycle_status = 'recovery_approved_scheduled'
      and (deduction_month is null or deduction_month > (select m from due_month))),0),
  'due_this_cycle', coalesce((select count(*)::int from recoverable
    where lifecycle_status in ('recovery_approved_scheduled','recovery_in_progress')
      and approval_status='approved' and deduction_month <= (select m from due_month)),0),
  'overdue', coalesce((select count(*)::int from recoverable
    where lifecycle_status in ('recovery_approved_scheduled','recovery_in_progress')
      and approval_status='approved' and deduction_month < (select m from due_month)),0),
  'blocked_cap', coalesce((select count(*)::int from recoverable where cap_override is false
    and lifecycle_status = 'needs_review' and lifecycle_note ilike '%cap%'),0),
  'blocked_needs_review', coalesce((select count(*)::int from recoverable
    where lifecycle_status = 'needs_review'),0),
  'blocked_exit', coalesce((select count(*)::int from recoverable
    where lifecycle_status = 'exit_balance'),0),
  'on_hold', coalesce((select count(*)::int from recoverable where lifecycle_status = 'on_hold'),0),
  'by_station', coalesce((
    select jsonb_agg(jsonb_build_object(
      'station_code', station_code,
      'recoverable', recoverable_amount,
      'outstanding', outstanding_amount
    ) order by station_code)
    from (
      select station_code,
        round(sum(amount),2) recoverable_amount,
        round(sum(case when lifecycle_status in (
          'recovery_approved_scheduled','recovery_in_progress','exit_balance','needs_review','slp_final_confirmation_pending'
        ) then amount else 0 end),2) outstanding_amount
      from recoverable group by station_code
    ) x
  ), '[]'::jsonb),
  'salary_month', (select m from due_month)
 )
$$;

-- ─── 12. Action items for daily digest ───────────────────────────────────────
create or replace function public.nl_loss_recovery_action_items(p_company uuid)
returns table(
  station_code text, month text, case_key text, report text, amount numeric,
  lifecycle_status text, action_key text, action_label text, owner_role text,
  age_days int, due_month text, blocker text, deep_link text
) language sql stable security invoker set search_path=public as $$
 select c.station_code, c.month, c.case_key, c.report, c.amount, c.lifecycle_status,
  v.action_key, v.action_label, v.owner_role,
  greatest(0, (timezone('Asia/Kolkata', now()))::date
    - coalesce(c.lifecycle_updated_at, c.last_seen_at, c.source_updated_at)::date) age_days,
  r.deduction_month,
  case
    when c.lifecycle_status = 'needs_review' then coalesce(nullif(c.lifecycle_note,''),'Needs review')
    when c.lifecycle_status = 'exit_balance' then 'Exit balance outstanding'
    when c.report = 'slp' and c.final_seen_at is null then 'Awaiting SLP Final'
    else null
  end blocker,
  '/team-ops/losses/'||case c.report when 'slp' then 'slp' when 'station' then 'nl' else 'nl' end
    ||'?month='||c.month||'&station='||c.station_code||'&case='||c.case_key
 from nl_loss_month_cases c
 left join nl_loss_recoveries r
   on r.company_id=c.company_id and r.month=c.month and r.case_key=c.case_key and not r.is_deleted
 cross join lateral (
  select * from (values
   ('station_dispute_or_clarification_window','station_clarification','Station dispute / clarification','station'),
   ('returned_to_station','station_clarification','Returned to station','station'),
   ('cluster_validation_pending','cluster_validation','Cluster validation','cluster'),
   ('imported','cluster_validation','Ready for cluster validation','cluster'),
   ('slp_final_confirmation_pending','slp_confirmation','SLP final confirmation','slp'),
   ('needs_review','recovery_review','Recovery needs review','cluster'),
   ('exit_balance','recovery_blocked','Exit balance','slp'),
   ('recovery_approved_scheduled','recovery_due','Approved — schedule / due','recovery_owner')
  ) as x(status, action_key, action_label, owner_role)
  where x.status = c.lifecycle_status
 ) v
 where c.company_id = p_company and c.source_present
   and nl_case_recoverable(p_company, c.report, c.source_status)
$$;

-- ─── 13. Legacy backfill (in-flight plans stay payroll-eligible) ─────────────
update public.nl_loss_recoveries r set
  approval_status = 'approved',
  approved_at = coalesce(r.approved_at, r.assigned_at, r.updated_at),
  approved_by_name = coalesce(r.approved_by_name, r.updated_by_name),
  proposed_at = coalesce(r.proposed_at, r.assigned_at, r.updated_at),
  proposed_by_name = coalesce(r.proposed_by_name, r.updated_by_name)
where not r.is_deleted
  and r.deduction_timing <> 'none'
  and r.approval_status = 'none'
  and jsonb_array_length(coalesce(r.allocations,'[]')) > 0;

update public.nl_loss_month_cases c set
  lifecycle_status = case
    when not public.nl_case_recoverable(c.company_id, c.report, c.source_status) then 'not_recoverable'
    when c.report = 'slp' and c.final_seen_at is null
      and not coalesce((c.details->>'in_final')::boolean,false) then 'imported'
    when exists(
      select 1 from nl_loss_recoveries r
      where r.company_id=c.company_id and r.month=c.month and r.case_key=c.case_key
        and not r.is_deleted and r.approval_status='approved' and r.deduction_timing<>'none'
    ) then 'recovery_approved_scheduled'
    when c.report = 'nl' and coalesce(c.data_source,'live') = 'live'
      and c.lifecycle_status = 'imported' then 'station_dispute_or_clarification_window'
    when c.lifecycle_status = 'imported' then 'cluster_validation_pending'
    else c.lifecycle_status
  end,
  lifecycle_updated_at = coalesce(c.lifecycle_updated_at, now())
where c.source_present
  and c.lifecycle_status = 'imported';

-- Best-effort sync for backfilled approved cases (ignore ledger errors on sparse fixtures).
do $$
declare rec record;
begin
  for rec in
    select company_id, month, case_key from public.nl_loss_month_cases
    where lifecycle_status = 'recovery_approved_scheduled' and source_present
  loop
    begin
      perform public.nl_loss_lifecycle_sync(rec.company_id, rec.month, rec.case_key);
    exception when others then null;
    end;
  end loop;
end $$;

revoke all on function public.nl_loss_lifecycle_transition(uuid,text,text,text,int,uuid,text,text) from public, anon, authenticated;
revoke all on function public.nl_loss_recovery_approve(uuid,text,text,int,uuid,text,text,int) from public, anon, authenticated;
revoke all on function public.nl_loss_clarification_submit(uuid,text,text,uuid,text,text,text,text,text,text,jsonb,text) from public, anon, authenticated;
revoke all on function public.nl_loss_clarification_resolve(uuid,uuid,text,int,uuid,text,text) from public, anon, authenticated;
revoke all on function public.nl_loss_lifecycle_sync(uuid,text,text) from public, anon, authenticated;
revoke all on function public.nl_loss_recovery_command_summary(uuid,text[],text) from public, anon, authenticated;
revoke all on function public.nl_loss_recovery_action_items(uuid) from public, anon, authenticated;
revoke all on function public.nl_loss_recovery_due(uuid,text,text,uuid) from public, anon, authenticated;
revoke all on function public.save_nl_recovery(uuid,text,text,int,text,text,jsonb,text,uuid,text,jsonb,jsonb) from public, anon, authenticated;

grant execute on function public.nl_loss_lifecycle_transition(uuid,text,text,text,int,uuid,text,text) to service_role;
grant execute on function public.nl_loss_recovery_approve(uuid,text,text,int,uuid,text,text,int) to service_role;
grant execute on function public.nl_loss_clarification_submit(uuid,text,text,uuid,text,text,text,text,text,text,jsonb,text) to service_role;
grant execute on function public.nl_loss_clarification_resolve(uuid,uuid,text,int,uuid,text,text) to service_role;
grant execute on function public.nl_loss_lifecycle_sync(uuid,text,text) to service_role;
grant execute on function public.nl_loss_recovery_command_summary(uuid,text[],text) to service_role;
grant execute on function public.nl_loss_recovery_action_items(uuid) to service_role;
grant execute on function public.nl_loss_recovery_due(uuid,text,text,uuid) to service_role;
grant execute on function public.save_nl_recovery(uuid,text,text,int,text,text,jsonb,text,uuid,text,jsonb,jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
