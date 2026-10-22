-- KANALA ANIL KUMAR (D0945): restore Oct 2 holiday credit (wrongly lapsed with a
-- flat 14-day rule; HRMS keeps holidays on/before the 25th until the 2nd of the
-- next month) and ensure Oct 20 Dussehra credit exists.
begin;

-- Undo the incorrect 2026-10-22 lapse debit for the 2026-10-02 credit.
insert into public.hr_leave_balance_ledger (
  company_id, worker_type, worker_id, leave_type_id, leave_year,
  entry_type, days, source, reference_id, reference_date, note
)
select
  l.company_id, l.worker_type, l.worker_id, l.leave_type_id, 0,
  'adjustment', -l.days, 'hr_manual_adjustment', l.id, l.reference_date,
  'Restored Gandhi Jayanti holiday comp-off: mid-month holiday stays usable until 2 Nov (not a 14-day lapse).'
from public.hr_leave_balance_ledger l
where l.worker_id = '5314ae8d-5167-4d8e-a782-a8e76e1186a7'::uuid
  and l.leave_type_id = 'cdf8db02-5359-438f-8eff-35feedadcfa9'::uuid
  and l.source = 'comp_off_lapsed'
  and l.reference_date = '2026-10-22'
  and l.note like 'Holiday Comp Off lapsed: unused credit from 2026-10-02%'
  and not exists (
    select 1 from public.hr_leave_balance_ledger r
    where r.source = 'hr_manual_adjustment' and r.reference_id = l.id
  );

-- Ensure Dussehra credit (accrual may have already inserted this).
insert into public.hr_leave_balance_ledger (
  company_id, worker_type, worker_id, leave_type_id, leave_year,
  entry_type, days, source, reference_date, note
)
values (
  '43866344-b550-4e8a-9a2d-9d23f3d8a997'::uuid,
  'contractor',
  '5314ae8d-5167-4d8e-a782-a8e76e1186a7'::uuid,
  'cdf8db02-5359-438f-8eff-35feedadcfa9'::uuid,
  0, 'credit', 1, 'comp_off_earned', '2026-10-20',
  'Dussehra worked holiday — credited after missed accrual.'
)
on conflict (company_id, worker_type, worker_id, leave_type_id, reference_date)
  where source = 'comp_off_earned' do nothing;

commit;
