begin;
-- Every new recovery update is a proposal. Existing approved collections and payroll keys stay intact.
do $$ declare f record; definition text; patched boolean:=false; begin
 for f in select oid from pg_proc where pronamespace='public'::regnamespace and proname='save_nl_recovery' loop
  definition:=pg_get_functiondef(f.oid);
  if position('-- All recovery updates require final approval' in definition)>0 then patched:=true; continue; end if;
  if position('-- Allocating plans require SLP approval before they are due.' in definition)>0 then
   definition:=regexp_replace(definition,'-- Allocating plans require SLP approval before they are due[\s\S]*?  insert into nl_loss_recoveries\(',
    E'-- All recovery updates require final approval, including receipts and departed people.\n  v_approval := ''proposed'';\n  next_lifecycle := ''slp_final_confirmation_pending'';\n\n  insert into nl_loss_recoveries(');
   definition:=replace(definition,'elsif o.code <> ''responsible_left'' then','elsif o.code not in (''responsible_left'',''already_recovered'') then');
   if position('-- All recovery updates require final approval' in definition)=0 then raise exception 'Recovery approval patch failed'; end if;
   execute definition; patched:=true;
  end if;
 end loop;
 if not patched then raise exception 'Recovery writer was not found'; end if;
end $$;

create or replace function public.nl_recovery_receipt_guard() returns trigger language plpgsql set search_path=public as $$
begin
 if not new.is_deleted and new.outcome_code='already_recovered' then
  if coalesce(new.recovery_details->>'received_amount','') !~ '^[0-9]+(\.[0-9]{1,2})?$' then raise exception 'Enter the full received amount.'; end if;
  if round((new.recovery_details->>'received_amount')::numeric,2)<>round(new.source_amount,2) then raise exception 'Full recovery must equal the loss amount. Partial collections remain outstanding.'; end if;
  if length(trim(coalesce(new.recovery_details->>'receipt_reference','')))<5 or coalesce(new.recovery_details->>'received_date','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Receipt reference and received date are required.'; end if;
  if (new.recovery_details->>'received_date')::date > (now() at time zone 'Asia/Kolkata')::date then raise exception 'Received date cannot be in the future.'; end if;
 end if;
 return new;
end $$;
drop trigger if exists nl_recovery_receipt_guard on public.nl_loss_recoveries;
create trigger nl_recovery_receipt_guard before insert or update of outcome_code,recovery_details,remarks on public.nl_loss_recoveries for each row execute function public.nl_recovery_receipt_guard();
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
  target text;
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
  if r.proposed_by is not null and r.proposed_by = p_actor then
    raise exception 'You proposed this recovery, so another authorised person must approve it.';
  end if;
  if round(c.amount, 2) is distinct from round(r.source_amount, 2) then
    raise exception 'The imported loss amount changed. Return the plan for re-proposal.';
  end if;
  if note is not null and length(note) > 2000 then
    raise exception 'Keep the note under 2,000 characters.';
  end if;

  target := case when r.outcome_code='already_recovered' then 'recovered' when r.outcome_code='responsible_left' then 'exit_balance' else 'recovery_approved_scheduled' end;
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
    lifecycle_status = target,
    lifecycle_version = lifecycle_version + 1,
    lifecycle_note = coalesce(note, ''),
    lifecycle_updated_by = p_actor,
    lifecycle_updated_by_name = p_name,
    lifecycle_updated_at = now()
  where company_id = p_company and month = p_month and case_key = p_case;

  insert into public.nl_loss_lifecycle_events(
    company_id, month, case_key, action, from_status, to_status, note, actor_id, actor_name, snapshot
  ) values (
    p_company, p_month, p_case, 'approve_recovery', c.lifecycle_status, target,
    coalesce(note,''), p_actor, p_name, to_jsonb(saved)
  );
  insert into public.nl_loss_recovery_events(company_id, month, case_key, before_value, after_value, actor_id, actor_name)
  values (p_company, p_month, p_case, to_jsonb(r), to_jsonb(saved), p_actor, p_name);

  if exists(select 1 from jsonb_array_elements(saved.allocations) x where x->>'ref' like 'workforce:%') then
    perform public.nl_recovery_bump_payout_months(p_company, array[saved.deduction_month]);
  end if;
  return to_jsonb(saved);
end $$;


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

  if p_action='reject' then raise exception 'Return the update for correction; an unpaid loss cannot be rejected.'; end if;
  target := case
    when p_action = 'open_station_window' and c.lifecycle_status = 'imported'
      then 'station_dispute_or_clarification_window'
    when p_action = 'ready_for_cluster'
      and c.lifecycle_status in ('imported','station_dispute_or_clarification_window','returned_to_station')
      then 'cluster_validation_pending'
    when p_action = 'return_to_station'
      and c.lifecycle_status in ('cluster_validation_pending','slp_final_confirmation_pending','needs_review','recovery_approved_scheduled','recovery_in_progress','exit_balance','on_hold')
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


-- A TT is an auditable follow-up, never an imported vendor decision or proof of collection.
alter table public.nl_case_response_windows add column if not exists tt_reference text;
alter table public.nl_case_response_windows add column if not exists tt_url text;
alter table public.nl_case_response_windows add column if not exists followup_status text not null default 'preparing';
alter table public.nl_case_response_windows add column if not exists followup_on date;
alter table public.nl_case_response_events add column if not exists tracking jsonb;
alter table public.nl_case_response_events drop constraint if exists nl_case_response_events_action_check;
alter table public.nl_case_response_events add constraint nl_case_response_events_action_check check(action in ('activate','revoke','response','vendor_response','tracking'));
create or replace function public.nl_redispute_track(p_company uuid,p_month text,p_case text,p_version integer,p_reference text,p_url text,p_status text,p_due date,p_note text,p_actor uuid,p_name text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare w nl_case_response_windows;
begin
 if p_actor is null or length(trim(coalesce(p_name,'')))=0 then raise exception 'An authenticated actor is required.'; end if;
 if p_status not in ('preparing','filed','with_vendor','returned','won','lost','closed') then raise exception 'Choose a valid follow-up status.'; end if;
 if length(trim(coalesce(p_note,'')))<10 or length(p_note)>4000 then raise exception 'Record the update (10–4000 characters).'; end if;
 if length(coalesce(p_reference,''))>160 or length(coalesce(p_url,''))>2000 or (coalesce(p_url,'')<>'' and p_url !~ '^https://') then raise exception 'Use a valid TT reference and HTTPS portal link.'; end if;
 if p_status in ('filed','with_vendor','returned','won','lost') and length(trim(coalesce(p_reference,'')))<3 then raise exception 'Enter the LSC TT reference.'; end if;
 if p_status in ('filed','with_vendor','returned') and p_due is null then raise exception 'Set the next follow-up date.'; end if;
 select * into strict w from nl_case_response_windows where company_id=p_company and month=p_month and case_key=p_case for update;
 if w.version<>p_version then raise exception 'This redispute changed. Reload before updating.'; end if;
 if not w.enabled then raise exception 'Activate this TID before tracking a redispute.'; end if;
 update nl_case_response_windows set tt_reference=nullif(trim(p_reference),''),tt_url=nullif(trim(p_url),''),followup_status=p_status,followup_on=p_due,
  enabled=case when p_status='closed' then false else enabled end,version=version+1,updated_at=now(),updated_by=p_actor,updated_by_name=p_name
 where company_id=p_company and month=p_month and case_key=p_case returning * into w;
 insert into nl_case_response_events(company_id,month,case_key,action,note,actor_id,actor_name,tracking)
 values(p_company,p_month,p_case,'tracking',trim(p_note),p_actor,p_name,to_jsonb(w));
 -- A claimed successful redispute needs source verification before further deductions.
 if p_status='won' and exists(select 1 from nl_loss_month_cases where company_id=p_company and month=p_month and case_key=p_case and lifecycle_status not in ('recovered','written_off','not_recoverable')) then
  update nl_loss_month_cases set lifecycle_status='needs_review',lifecycle_version=lifecycle_version+1,lifecycle_note='Redispute reported won; verify source outcome.',lifecycle_updated_by=p_actor,lifecycle_updated_by_name=p_name,lifecycle_updated_at=now()
   where company_id=p_company and month=p_month and case_key=p_case and lifecycle_status not in ('recovered','written_off','not_recoverable');
  update nl_loss_recoveries set approval_status='needs_review',version=version+1,approval_note='Verify successful redispute against source before further recovery.'
   where company_id=p_company and month=p_month and case_key=p_case and not is_deleted and approval_status in ('approved','proposed');
  insert into nl_loss_lifecycle_events(company_id,month,case_key,action,from_status,to_status,note,actor_id,actor_name)
   values(p_company,p_month,p_case,'redispute_verification',null,'needs_review',trim(p_note),p_actor,p_name);
 end if;
 return to_jsonb(w);
end $$;
revoke all on function public.nl_redispute_track(uuid,text,text,integer,text,text,text,date,text,uuid,text) from public,anon,authenticated;
grant execute on function public.nl_redispute_track(uuid,text,text,integer,text,text,text,date,text,uuid,text) to service_role;
-- A write-off cannot bypass proposal approval or be decided by its proposer.
do $$ declare f record; definition text; begin
 for f in select oid from pg_proc where pronamespace='public'::regnamespace and proname='waive_nl_recovery_balance' loop
  definition:=pg_get_functiondef(f.oid);
  if position('-- Product write-off approval guard' in definition)=0 then
   definition:=replace(definition,' select * into l from nl_recovery_ledger', E' -- Product write-off approval guard\n if not exists(select 1 from nl_loss_recoveries where company_id=p_company and month=p_month and case_key=p_case and not is_deleted and approval_status=''approved'' and proposed_by is distinct from p_actor) then raise exception ''Only an independently approved recovery may be considered for write-off.''; end if;\n select * into l from nl_recovery_ledger');
   if position('-- Product write-off approval guard' in definition)=0 then raise exception 'Write-off guard patch failed'; end if;
   execute definition;
  end if;
 end loop;
end $$;

-- Explicitly authorised final roles retain their existing membership and station scopes.
insert into public.role_page_permissions(company_id,role_id,page_id,can_view,can_add,can_edit)
select r.company_id,r.id,p.id,true,false,true
from public.user_roles r join public.app_pages p on p.company_id=r.company_id and p.code='ops_losses'
where r.is_active and r.code in ('OPERATIONS_FINMGR','OPERATIONS_MANAGING_PARTNER','OPERATIONS_NATIONAL_HEAD')
on conflict(company_id,role_id,page_id) do update set can_view=true,can_edit=true;
commit;
