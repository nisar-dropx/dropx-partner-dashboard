-- Mirror: add overnight shifts to People Shift Master (idempotent).
-- Run on shared Supabase if HRMS migrations are not auto-applied.

insert into public.hr_shifts (
  company_id,
  code,
  name,
  start_time,
  end_time,
  break_minutes,
  grace_in_minutes,
  grace_out_minutes,
  color,
  is_active,
  updated_at
)
select
  company.id,
  seed.code,
  seed.name,
  seed.start_time::time,
  seed.end_time::time,
  seed.break_minutes,
  seed.grace_in_minutes,
  seed.grace_out_minutes,
  seed.color,
  true,
  now()
from public.companies company
cross join (
  values
    ('PM3_MIDNIGHT', '3 PM – 12 AM', '15:00', '00:00', 60, 15, 0, '#C2410C'),
    ('PM11_AM8', '11 PM – 8 AM', '23:00', '08:00', 60, 15, 0, '#1E3A8A')
) as seed(code, name, start_time, end_time, break_minutes, grace_in_minutes, grace_out_minutes, color)
on conflict (company_id, code) do update
set
  name = excluded.name,
  start_time = excluded.start_time,
  end_time = excluded.end_time,
  break_minutes = excluded.break_minutes,
  grace_in_minutes = excluded.grace_in_minutes,
  grace_out_minutes = excluded.grace_out_minutes,
  color = excluded.color,
  is_active = true,
  updated_at = now();
