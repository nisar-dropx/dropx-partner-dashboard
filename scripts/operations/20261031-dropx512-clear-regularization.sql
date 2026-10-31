-- DROPX512 (SHIBIN DAS CG): clear the latest attendance regularization so he
-- can submit again. Approved rows block the Connect/One UI from offering
-- "Request regularization" for that day.
begin;

do $$
declare
  company uuid := '43866344-b550-4e8a-9a2d-9d23f3d8a997';
  emp uuid := '0b7a0aa9-4cb8-477b-b296-198dcbcbb1de'; -- DROPX512 / SHIBIN DAS CG
  target uuid;
  target_date date;
  n int;
begin
  -- Prefer any still-open request; otherwise the newest approved one.
  select id, attendance_date
  into target, target_date
  from public.attendance_regularization_requests
  where company_id = company
    and profile_type = 'employee'
    and profile_id = emp
    and status in ('pending', 'pending_manager', 'pending_hr', 'returned', 'approved')
  order by
    case status
      when 'pending' then 0
      when 'pending_manager' then 0
      when 'pending_hr' then 0
      when 'returned' then 1
      else 2
    end,
    attendance_date desc,
    created_at desc
  limit 1;

  if target is null then
    raise notice 'DROPX512: no open/approved regularization to clear';
    return;
  end if;

  delete from public.attendance_regularization_approval_steps
  where company_id = company and request_id = target;
  get diagnostics n = row_count;
  raise notice 'DROPX512 steps removed for % (%): %', target, target_date, n;

  delete from public.attendance_regularization_requests
  where company_id = company and id = target;
  get diagnostics n = row_count;
  raise notice 'DROPX512 request removed for % (%): %', target, target_date, n;
end $$;

commit;
