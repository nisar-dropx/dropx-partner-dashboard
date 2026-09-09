# Server-side recurring portal mail

People sends the previous attendance day's Unplanned Leave digest at 08:00 Asia/Kolkata.
Ops Pulse sends the previous performance day's review digest at 20:30 Asia/Kolkata.
These jobs run on the respective production Vercel project, not on a laptop or Codex.

## Administration
Settings → Notifications is separately permissioned in each portal. Authorized administrators
can enable, disable, pause/resume, change the daily time, monthly subject, reminder and
relevant scope codes. Delivery history is tenant/portal-scoped. Existing notification routes
and cron entries are preserved. Database configuration drives the schedule and scope;
the Vercel heartbeat runs each minute and the service checks whether today's run is due.

## Release dependency
The shared Supabase schema is in the People repository migration
20260909194025_portal_recurring_mail_delivery.sql. All five RPCs and three delivery tables
are service-role only, with no browser grants; table RLS intentionally has no public policies.
Both portal deployments must be verified before setting delivery_ready=true and enabling
the appropriate company's controls. The first scheduled report is 2026-09-09.

## Delivery safety
A fresh snapshot resolves current active recipients and authorized reporting/location scope.
Every recipient receives a separate message. HR receives the whole organization for People.
People lists direct reportees first, then the subordinate team grouped by reporting branch.
Ops uses configured models (initially EDSP and XPT) and active Operations membership scope.

An atomic unique run key prevents duplicate enqueues. Pending rows are claimed with
SKIP LOCKED and become sending before SMTP. An accepted result and monthly reply IDs are
saved together. SMTP uncertainty or interrupted sending is held for human verification,
never automatically resent. A skipped pre-send failure is visible in delivery history.
No manual retries are exposed until an operator has verified the provider receipt.

Monthly thread identity includes company, portal, event, recipient and report month.
September's earlier sent message IDs were imported as thread roots (not resent).
Subjects remain fixed within a monthly thread and change on the next report month.

## Verification
Boundary tests cover IST timing, previous-day/month rollover, pause/disable, first report date,
cron secret rejection, thread isolation and settings validation. Snapshot tests verify complete
named-person coverage, HR scope, verified location mailboxes, no duplicate recipients,
HTML escaping, dynamic dates and EDSP/XPT exclusions. Transactional queue tests verify
duplicate enqueue and repeated claim protection and roll back without sending mail.
