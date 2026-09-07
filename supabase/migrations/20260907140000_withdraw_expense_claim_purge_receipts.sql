-- Claimant may withdraw a pending/returned reimbursement claim.
-- Receipt attachment rows are removed and storage paths returned so One can purge files.

begin;

alter table public.hr_expense_claims
  drop constraint if exists hr_expense_claims_status_check;

alter table public.hr_expense_claims
  add constraint hr_expense_claims_status_check
  check (status in (
    'draft',
    'pending_approval',
    'returned',
    'rejected',
    'approved_for_payment',
    'payment_processing',
    'paid',
    'payment_returned',
    'payment_rejected',
    'cancelled',
    'withdrawn'
  ));

create or replace function public.hr_withdraw_expense_claim(
  p_company_id uuid,
  p_claim_id uuid,
  p_actor_user_id uuid,
  p_note text default null
) returns table(claim_id uuid, claim_status text, storage_paths text[])
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claim public.hr_expense_claims%rowtype;
  v_actor_name text;
  v_actor_role text;
  v_paths text[] := '{}'::text[];
  v_reason text;
begin
  select claim.* into v_claim
  from public.hr_expense_claims claim
  where claim.company_id = p_company_id and claim.id = p_claim_id
  for update;
  if not found then raise exception 'Reimbursement claim was not found.'; end if;

  if v_claim.claimant_user_id is distinct from p_actor_user_id then
    raise exception 'You can withdraw only your own reimbursement claim.';
  end if;

  if v_claim.status not in ('pending_approval', 'returned') then
    raise exception 'Only a pending or returned reimbursement claim can be withdrawn.';
  end if;

  if v_claim.payment_request_id is not null then
    raise exception 'This claim has already been sent to Payments and cannot be withdrawn.';
  end if;

  v_reason := trim(coalesce(p_note, ''));
  if length(v_reason) < 3 then
    raise exception 'A reason is required to withdraw this reimbursement claim.';
  end if;

  select coalesce(array_agg(attachment.storage_path order by attachment.created_at), '{}'::text[])
  into v_paths
  from public.hr_expense_attachments attachment
  where attachment.company_id = p_company_id
    and attachment.claim_id = p_claim_id;

  delete from public.hr_expense_attachments attachment
  where attachment.company_id = p_company_id
    and attachment.claim_id = p_claim_id;

  update public.hr_expense_approval_steps step
  set status = 'skipped',
      decision_note = coalesce(step.decision_note, 'Skipped — claim withdrawn'),
      updated_at = now()
  where step.company_id = p_company_id
    and step.claim_id = p_claim_id
    and step.status in ('pending', 'waiting');

  if v_claim.claim_request_id is not null then
    update public.hr_expense_claim_requests claim_request
    set consumed_claim_id = null,
        updated_at = now()
    where claim_request.company_id = p_company_id
      and claim_request.id = v_claim.claim_request_id
      and claim_request.consumed_claim_id = p_claim_id;
  end if;

  select profile.full_name, coalesce(profile.role::text, 'Claimant')
  into v_actor_name, v_actor_role
  from public.profiles profile
  where profile.id = p_actor_user_id;

  update public.hr_expense_claims claim
  set status = 'withdrawn',
      current_step = null,
      rejection_reason = v_reason,
      decided_at = now(),
      updated_at = now()
  where claim.id = p_claim_id;

  insert into public.hr_expense_events(
    company_id, claim_id, event_type, from_status, to_status,
    actor_user_id, actor_name, actor_role, comments, metadata
  )
  values (
    p_company_id, p_claim_id, 'withdrawn', v_claim.status, 'withdrawn',
    p_actor_user_id, coalesce(v_actor_name, 'Claimant'), coalesce(v_actor_role, 'Claimant'),
    v_reason,
    jsonb_build_object('purged_attachment_count', coalesce(cardinality(v_paths), 0))
  );

  return query select p_claim_id, 'withdrawn'::text, v_paths;
end $$;

grant execute on function public.hr_withdraw_expense_claim(uuid, uuid, uuid, text) to service_role;

commit;
