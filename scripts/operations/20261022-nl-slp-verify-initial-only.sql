select case_key, source_status, lifecycle_status, final_seen_at is not null as has_final
from nl_loss_month_cases
where company_id='43866344-b550-4e8a-9a2d-9d23f3d8a997'
  and case_key='slp:July-Aug|28072026_KDJE_23581|368321615281|368321615281';
