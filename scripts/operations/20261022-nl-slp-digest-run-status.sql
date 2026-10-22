select company_id::text, report_date, created_at
from portal_digest_runs
where event_key = 'loss_recovery_action_digest'
order by created_at desc
limit 10;
