-- NL/SLP ops enablement checks (read-only). Safe to re-run.

-- 1) Digest control
select
  state,
  config->>'delivery_ready' as ready,
  config->>'schedule_time' as schedule_time,
  config->>'first_report_date' as first_report_date,
  config->>'timezone' as timezone,
  config->>'email_domain' as email_domain,
  subject_template,
  company_id
from portal_notification_controls
where portal = 'ops' and event_key = 'loss_recovery_action_digest';
