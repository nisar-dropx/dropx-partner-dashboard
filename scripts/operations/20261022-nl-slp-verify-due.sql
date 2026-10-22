select case_key, recovery_key, amount::text, employee_ref, installment_no, installment_count
from nl_loss_recovery_due('43866344-b550-4e8a-9a2d-9d23f3d8a997','2026-10','workforce')
where case_key in (
  '630199769121',
  'slp:June-July|02062026_JDBD_51902|2606020280|368262515886'
)
order by case_key, coalesce(installment_no,0);
