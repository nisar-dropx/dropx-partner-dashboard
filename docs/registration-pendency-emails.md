# Registration pendency emails

Native OpsPulse cron, not a workstation automation. The existing five-minute
`/api/cron/portal-notifications` worker builds two independent daily reports:
09:30 and 15:30 Asia/Kolkata. Each control's `first_report_date` determines
the first eligible report date and is set at production activation.
The database migration deliberately installs both controls disabled.

## Source and audience

- People employee/independent-contractor profiles and Workforce profiles use
  their canonical completion status and current designation/category field rules.
- Only pending, returned/rejected, submitted/under-review and approved-but-not-
  activated registrations are considered. Completed, deleted, exited,
  offboarded and migrated duplicate profiles are excluded.
- Saved registration draft evidence is used for pending profiles; it never
  counts as submission or overrides a submitted profile.
- Required/optional missing fields are separate. PF/ESI follow statutory
  applicability. Attachment contains presence/status only, never the actual
  government identifiers, bank account details or document files.
- Routing uses the effective primary reporting relationship first, then the
  station's canonical Cluster/City Manager or AOM. Explicit station-scoped
  operations manager membership is the final fallback. Blanket admin access
  is not a fallback recipient. Ambiguous/missing/inactive managers are held.
- Ops managers receive both workspaces for their assigned locations and canonical
  reportees. Blanket Ops access alone does not subscribe a user company-wide.
- With `team_recipients_enabled`, active HR roles receive **People only** and
  Finance/Accounts roles receive **Workforce only**, within their current location
  permissions. Department rules override direct-report and Ops-membership routing.
  Explicit HR + Finance roles receive the union of their separately authorized
  workspaces. Shared/ambiguous addresses cannot be added as team recipients.
- Recipients receive a single scoped email per edition, never duplicate manager
  and department emails. Zero pending profiles means no message.
- The compact body shows up to 12 stations with most pendency. The Excel includes
  every authorized pending profile, station, Location Master cluster, current
  People cluster manager, status, missing fields and next action. Missing cluster
  mapping is labelled explicitly. The reminder asks managers to complete active
  registrations or verify and initiate offboarding for inactive people; it never
  offboards profiles automatically.
- Company owners can opt into a separate consolidated summary for each daily
  slot in Settings → Notifications. The subscription stores the signed-in
  owner's user ID, not an arbitrary recipient address. Active company identity
  and current owner access are checked again before every send. No subscription
  grants a role or broadens any manager's report. The summary includes unrouted
  profiles so owner follow-up can repair missing manager mappings; its Excel
  preserves each profile's actual manager. Zero company-wide pendency sends no mail.
- Managers use their unique active HRMS-linked account email, including personal
  domains. The reporting relationship and active company identity authorize the
  recipient. Other digest types retain their company-domain restriction.

## Delivery safeguards

Unique company/event/date run plus per-recipient delivery records prevent
duplicate enqueue. The afternoon run rebuilds the source; it is not a resend.
The queue rechecks pending profile keys and manager routing before SMTP.
Changed scope/completed profiles and reminders outside the delivery window
are held rather than sent stale. A transport-uncertain send is not retried
blindly. Morning and afternoon share one monthly email thread per recipient,
with distinct per-slot Message-IDs and a stable subject/root. At cutover, follow-ups
reuse the existing morning root when one exists; old emails cannot be merged
retroactively. If the first pending edition is afternoon, that becomes the root.

## Verification and activation

Owner-only `/api/ops-pulse/registration-email-preview` builds live scoped emails
and downloadable XLSX without sending. Its JSON view reports recipient counts,
unrouted profiles and SMTP configuration readiness. Validate routing and
attachment before setting the two `registration_pendency_*` controls to
`state='enabled'` and `config.delivery_ready=true`.
The reviewed production activation SQL is
`scripts/operations/20261101-registration-mail-schedule.sql`; it preserves
existing receipts, subscriptions and threads. It changes no HR/portal permissions.

OpsPulse → Settings → Notifications → Registration pendency provides separate
pause/disable/time controls and recent delivery status. Disabling either event
is the immediate rollback; it does not remove history or affect other digests.

Tests:

```sh
node --experimental-strip-types --test src/lib/registration-pendency.test.mjs src/lib/registration-summary-recipients.test.mjs src/lib/registration-mail-recipients.test.mjs src/lib/adhoc-digest.test.mjs
```
