-- KANALA ANIL KUMAR (D0945): keep the Oct 2 Gandhi Jayanti credit as lapsed
-- (14-day apply-by 2026-10-16 already posted) and ensure Oct 20 Dussehra credit
-- exists. DropX One shows "1 available · 1 lapsed".
begin;

-- Remove any restoration of the Oct 2 lapse so the UI can report it as lapsed.
delete from public.hr_leave_balance_ledger
where worker_id = '5314ae8d-5167-4d8e-a782-a8e76e1186a7'::uuid
  and leave_type_id = 'cdf8db02-5359-438f-8eff-35feedadcfa9'::uuid
  and source = 'hr_manual_adjustment'
  and note like 'Restored Gandhi Jayanti%';

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
