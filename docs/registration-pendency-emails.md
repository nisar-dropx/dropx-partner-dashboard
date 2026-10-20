# Registration pendency emails

Native OpsPulse cron, not a workstation automation. The existing five-minute
`/api/cron/portal-notifications` worker builds two independent daily reports:
09:30 and 16:00 Asia/Kolkata. First eligible report date: 21 October 2026.
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
- Each manager gets only their own profiles, grouped by station/store.
  Managers with zero pending profiles receive no message.

## Delivery safeguards

Unique company/event/date run plus per-recipient delivery records prevent
duplicate enqueue. The afternoon run rebuilds the source; it is not a resend.
The queue rechecks pending profile keys and manager routing before SMTP.
Changed scope/completed profiles and reminders outside the delivery window
are held rather than sent stale. A transport-uncertain send is not retried
blindly. Morning and afternoon have independent monthly email threads.

## Verification and activation

Owner-only `/api/ops-pulse/registration-email-preview` builds live scoped emails
and downloadable XLSX without sending. Its JSON view reports recipient counts,
unrouted profiles and SMTP configuration readiness. Validate routing and
attachment before setting the two `registration_pendency_*` controls to
`state='enabled'` and `config.delivery_ready=true`.

OpsPulse → Settings → Notifications → Registration pendency provides separate
pause/disable/time controls and recent delivery status. Disabling either event
is the immediate rollback; it does not remove history or affect other digests.

Tests:

```sh
node --experimental-strip-types --test src/lib/registration-pendency.test.mjs src/lib/id-mapping-digest.test.mjs src/lib/workforce-register-policy.test.mjs
```
