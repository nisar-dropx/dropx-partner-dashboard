begin;

create or replace function public.hr_validate_meaningful_roster_swap()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_requester_start time;
  v_requester_end time;
  v_partner_start time;
  v_partner_end time;
begin
  if new.requester_day_type = 'weekly_off'
     and new.partner_day_type = 'weekly_off' then
    raise exception 'Choose a colleague whose roster is different for this date.';
  end if;

  if new.requester_day_type = 'working'
     and new.partner_day_type = 'working' then
    if new.requester_shift_id is null or new.partner_shift_id is null then
      raise exception 'Both working roster entries need an assigned shift.';
    end if;

    select requester.start_time, requester.end_time, partner.start_time, partner.end_time
    into v_requester_start, v_requester_end, v_partner_start, v_partner_end
    from public.hr_shifts requester
    cross join public.hr_shifts partner
    where requester.id = new.requester_shift_id
      and partner.id = new.partner_shift_id;

    if not found then
      raise exception 'One of the selected shifts is unavailable.';
    end if;

    if v_requester_start = v_partner_start and v_requester_end = v_partner_end then
      raise exception 'Choose a colleague whose roster is different for this date.';
    end if;
  elsif (new.requester_day_type = 'working' and new.requester_shift_id is null)
     or (new.partner_day_type = 'working' and new.partner_shift_id is null) then
    raise exception 'The working roster entry needs an assigned shift.';
  end if;

  return new;
end;
$$;

revoke all on function public.hr_validate_meaningful_roster_swap() from public, anon, authenticated;

drop trigger if exists hr_roster_swap_meaningful_guard on public.hr_roster_swap_requests;
create trigger hr_roster_swap_meaningful_guard
before insert or update of requester_day_type, partner_day_type, requester_shift_id, partner_shift_id
on public.hr_roster_swap_requests
for each row
execute function public.hr_validate_meaningful_roster_swap();

comment on function public.hr_validate_meaningful_roster_swap() is
  'Rejects weekly-off-to-weekly-off, identical working-shift and incomplete roster swaps.';

commit;
