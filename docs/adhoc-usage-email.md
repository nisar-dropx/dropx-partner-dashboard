# Daily ad hoc usage email

The OpsPulse `/api/cron/portal-notifications` worker checks every five minutes. The `adhoc_usage_digest` control becomes due at **08:00 Asia/Kolkata** and reports the previous calendar day. MTD starts on the first day of the **report date's month**, including when delivery occurs on the first of the following month.

Only active, visible Amazon EDSP/XPT and Flipkart ODH/MDH stations qualify. A station must have at least one previous-day ad hoc van instance. DA-only activity and MTD-only van activity do not trigger email. Amazon Now, AMXL, Meesho, head offices and other programs are excluded.

Recipients require an active profile and active Operations product membership in one of the operational management/location roles in `adhoc-digest-scope.ts`. Membership location scope controls each recipient's rows. Finance, accounts, HR, developer and owner roles do not qualify. Station mailbox matching is limited to the Operations Location role. Recipient and station access are rechecked before SMTP delivery.

The HTML table has separate van, DA/WM and driver rows, with previous-day instances/amount, MTD instances/amount and a station total. Driver rows appear when the station has driver activity in the report month. Counts represent approved payment request instances or unlinked cashbook entries; linked cashbook rows are not counted twice. Pending and rejected requests are excluded. Existing dashboard totals remain unchanged; a resource category separates driver entries within the email.

The existing company SMTP configuration, atomic daily outbox, monthly email threads and delivery receipts are reused. Empty reports send no mail. Source query failures or qualifying stations without any operations recipient abort report preparation. Ambiguous SMTP results are held for review rather than automatically resent.

## Setup and operations

1. Run `scripts/configure-adhoc-usage-digest.sql` to create a disabled control for DropX Logistics. It does not overwrite an existing control.
2. Verify a read-only preview, run `node --test src/lib/adhoc-digest.test.mjs src/lib/ops-pulse/adhoc-activity.test.mjs` and run `scripts/verify-adhoc-digest-queue.sql` before the first delivery. The SQL test rolls back everything.
3. Commit and push the code. Verify the OpsPulse production deployment before setting the control's state to `enabled` and `config.delivery_ready` to true. Preserve `first_report_date` to prevent an immediate historical send during setup.
4. To stop delivery, set this control's state to `disabled`. Review `portal_digest_runs` and `portal_digest_deliveries` filtered to `portal='ops'` and `event_key='adhoc_usage_digest'` for receipts or errors. Do not manually requeue `sending`/`uncertain` deliveries without checking SMTP acceptance.

This report runs on OpsPulse hosting and does not depend on a Codex desktop task being open. It adds no additional Vercel cron entry and cannot run on other product hosts.
