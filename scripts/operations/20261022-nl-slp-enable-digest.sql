-- Mark delivery ready and enable daily digest after controlled live verification.
update portal_notification_controls
set
  config = config || jsonb_build_object('delivery_ready', true),
  state = 'enabled',
  updated_at = now()
where portal = 'ops'
  and event_key = 'loss_recovery_action_digest';

select company_id::text, state, config->>'delivery_ready' as ready,
  config->>'schedule_time' as schedule_time, config->>'first_report_date' as first_report_date
from portal_notification_controls
where portal = 'ops' and event_key = 'loss_recovery_action_digest'
order by company_id;
