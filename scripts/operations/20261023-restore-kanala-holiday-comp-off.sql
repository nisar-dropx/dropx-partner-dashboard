-- KANALA ANIL KUMAR: give back the Holiday Comp Off earned 2026-10-02 that was
-- manually lapsed on 2026-10-22 under the old flat 14-day rule. Mid-month holidays
-- stay usable through the 2nd of the next month, so the natural window is still open.
insert into public.hr_leave_balance_ledger(
  company_id, worker_type, worker_id, leave_type_id, leave_year, entry_type,
  days, source, reference_id, reference_date, note
)
select l.company_id, l.worker_type, l.worker_id, l.leave_type_id, 0, 'adjustment',
       -l.days, 'hr_manual_adjustment', l.id, '2026-10-02',
       'Restored Holiday Comp Off earned 2026-10-02 (give-back of mistaken 14-day lapse).'
from public.hr_leave_balance_ledger l
where l.id = 'fdd4acd2-2f60-4a1b-88c1-1bf10dc6f3e0'
  and not exists (
    select 1 from public.hr_leave_balance_ledger r
    where r.source = 'hr_manual_adjustment' and r.reference_id = l.id
  );

select id, entry_type, days, source, reference_date, note
from public.hr_leave_balance_ledger
where worker_id = '5314ae8d-5167-4d8e-a782-a8e76e1186a7'
  and leave_type_id = 'cdf8db02-5359-438f-8eff-35feedadcfa9'
order by created_at;
