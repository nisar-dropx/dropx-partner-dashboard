# Advance-request email delivery

Finance receives one queue at 17:00 Asia/Kolkata daily. The snapshot contains
requests that reached Finance by the cutoff and remain outstanding, including
older requests. Approval-needed and approved-awaiting-payment amounts are shown
separately. Later arrivals enter the next daily edition. A zero queue sends no email.

Recipients come from each request's Finance approval step and active company
profile, not a hardcoded person or a broad legacy role. Each manager sees only
their assigned requests. Recheck assignments, status and SMTP settings before
sending; completed/reassigned items are removed from the saved payload.

`advance_finance_daily` in `portal_notification_controls` uses the existing Ops
digest scheduler, durable run uniqueness and SMTP receipt handling. The existing
five-minute portal worker picks it up at 17:00 IST and retries later if needed. Concurrent calls
share one company/date run. Every daily edition uses the previous email's subject,
root and last Message-ID, including across month boundaries. Ambiguous SMTP
delivery is held for verification rather than automatically sent twice.

Operational approvers receive their initial One submission notification directly
through `hr_claim_initial_advance_email`. The People approval worker discovers
other submissions and handoffs, and sends subsequent reminders in the same leased
thread. Existing working-hours and company reminder policies remain applicable to
that worker. The independent Ops advance reminder loop is removed. Finance steps
are excluded from both the initial claim and People's approval-email source view.

Rollout: apply only `20261102062806_advance_finance_daily_digest.sql`, deploy the
reviewed Dashboard/Ops commit, and verify the authenticated read-only
`/api/cron/advance-finance-digest?preview=1` on Ops. Set this event's
`config.delivery_ready` to true only after verification. Fin's UI and approval,
payment, deduction and payroll state transitions are unchanged.

Checks: `node --experimental-strip-types --test src/lib/advance-finance-digest.test.mjs`
and `node scripts/test-advance-finance-mail-migration.mjs`. The database test applies
the migration twice and verifies Finance exclusion, manager delivery leases,
paid-request removal and service-role-only access. No real email is sent by tests.
