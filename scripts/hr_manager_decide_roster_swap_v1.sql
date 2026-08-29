-- Manager final decision for Connect / People shift swaps.
-- Run once in Supabase SQL editor. Connect also has an app-side fallback until this exists.

create or replace function public.hr_manager_decide_roster_swap(
  p_company_id uuid,
  p_request_id uuid,
  p_actor_user_id uuid,
  p_accept boolean,
  p_note text default null
) returns public.hr_roster_swap_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  swap_row public.hr_roster_swap_requests%rowtype;
  now_ts timestamptz := now();
begin
  select * into swap_row
  from public.hr_roster_swap_requests
  where company_id = p_company_id and id = p_request_id
  for update;

  if swap_row.id is null then
    raise exception 'Shift swap request was not found.';
  end if;
  if swap_row.status <> 'pending_manager' then
    raise exception 'This shift swap is no longer awaiting manager approval.';
  end if;
  if swap_row.approver_user_id is distinct from p_actor_user_id then
    raise exception 'This shift swap belongs to another approver.';
  end if;

  if p_accept then
    update public.hr_roster_entries
    set shift_id = swap_row.partner_shift_id,
        day_type = swap_row.partner_day_type,
        updated_at = now_ts
    where company_id = p_company_id and id = swap_row.requester_entry_id;

    if not found then
      raise exception 'Requester roster entry is unavailable.';
    end if;

    update public.hr_roster_entries
    set shift_id = swap_row.requester_shift_id,
        day_type = swap_row.requester_day_type,
        updated_at = now_ts
    where company_id = p_company_id and id = swap_row.partner_entry_id;

    if not found then
      raise exception 'Partner roster entry is unavailable.';
    end if;
  end if;

  update public.hr_roster_swap_requests
  set status = case when p_accept then 'approved' else 'rejected' end,
      updated_at = now_ts
  where company_id = p_company_id and id = p_request_id and status = 'pending_manager'
  returning * into swap_row;

  if swap_row.id is null then
    raise exception 'Shift swap request could not be updated.';
  end if;

  return swap_row;
end;
$$;

grant execute on function public.hr_manager_decide_roster_swap(uuid, uuid, uuid, boolean, text) to authenticated, service_role;
