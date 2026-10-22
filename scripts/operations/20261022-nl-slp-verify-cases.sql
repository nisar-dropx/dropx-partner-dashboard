select c.case_key, c.lifecycle_status, r.approval_status, r.recovery_mode,
  r.installment_basis, r.installment_value, r.cap_override,
  left(coalesce(r.cap_override_reason,''), 60) as override_reason,
  r.proposed_by_name, r.approved_by_name, r.deduction_month
from nl_loss_month_cases c
join nl_loss_recoveries r using (company_id, month, case_key)
where c.company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997'
  and c.case_key in (
    '630199769121',
    'slp:June-July|02062026_JDBD_51902|2606020280|368262515886'
  )
order by c.case_key;
