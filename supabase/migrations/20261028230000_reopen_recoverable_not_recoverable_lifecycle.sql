-- When Amazon flips a case back to a recoverable source status, reopen the
-- workflow. Previously only the reverse path was handled, so ~Recoverable
-- cases stayed stuck on lifecycle not_recoverable and save_nl_recovery failed
-- even though the UI correctly showed Recoverable.

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

  -- Source became recoverable again: reopen a closed not_recoverable case.
  -- Do not override an explicit UPDATE that already chose a new lifecycle.
  if public.nl_case_recoverable(new.company_id, new.report, new.source_status)
     and old.lifecycle_status = 'not_recoverable'
     and new.lifecycle_status = 'not_recoverable'
     and new.source_present then
    new.lifecycle_status := case
      when new.report = 'nl' and coalesce(new.data_source, 'live') = 'live'
        then 'station_dispute_or_clarification_window'
      when new.report = 'slp'
        and new.final_seen_at is null
        and not coalesce((new.details->>'in_final')::boolean, false)
        then 'imported'
      else 'cluster_validation_pending'
    end;
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

-- One-time repair for cases already stuck (idempotent: only touches not_recoverable
-- rows that are recoverable at source and still present).
update public.nl_loss_month_cases c
set
  lifecycle_status = case
    when c.report = 'nl' and coalesce(c.data_source, 'live') = 'live'
      then 'station_dispute_or_clarification_window'
    when c.report = 'slp'
      and c.final_seen_at is null
      and not coalesce((c.details->>'in_final')::boolean, false)
      then 'imported'
    else 'cluster_validation_pending'
  end,
  lifecycle_version = c.lifecycle_version + 1,
  lifecycle_updated_at = now(),
  lifecycle_note = case
    when nullif(trim(coalesce(c.lifecycle_note,'')),'') is null
      then 'Reopened: source is recoverable again.'
    else c.lifecycle_note
  end
where c.source_present
  and c.lifecycle_status = 'not_recoverable'
  and public.nl_case_recoverable(c.company_id, c.report, c.source_status);
