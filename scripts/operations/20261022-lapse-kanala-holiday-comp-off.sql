-- KANALA ANIL KUMAR (D0945): Holiday Comp Off earned 2026-10-02 with a 14-day
-- lapse (apply-by 2026-10-16). Ledger still showed remaining 1 after expiry.
-- Post the same style of debit week-off lapse uses so HRMS and DropX One agree.
begin;

insert into public.hr_leave_balance_ledger (
  company_id, worker_type, worker_id, leave_type_id, leave_year,
  entry_type, days, source, reference_date, note
)
select
  '43866344-b550-4e8a-9a2d-9d23f3d8a997'::uuid,
  'contractor',
  '5314ae8d-5167-4d8e-a782-a8e76e1186a7'::uuid,
  'cdf8db02-5359-438f-8eff-35feedadcfa9'::uuid,
  0,
  'debit',
  -1,
  'comp_off_lapsed',
  current_date,
  'Holiday Comp Off lapsed: unused credit from 2026-10-02 (14-day rule, apply-by 2026-10-16).'
where not exists (
  select 1
  from public.hr_leave_balance_ledger existing
  where existing.company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'::uuid
    and existing.worker_type = 'contractor'
    and existing.worker_id = '5314ae8d-5167-4d8e-a782-a8e76e1186a7'::uuid
    and existing.leave_type_id = 'cdf8db02-5359-438f-8eff-35feedadcfa9'::uuid
    and existing.source = 'comp_off_lapsed'
    and existing.reference_date = current_date
);

commit;
