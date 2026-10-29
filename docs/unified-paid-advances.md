# Paid advances

Requests and approval steps remain in `hr_pay_advance_requests` and
`hr_pay_advance_steps`. The paid money has one source of truth:

- `pay_advances`: immutable principal, created only after Paid bank status and a UTR.
- `pay_advance_deductions`: payroll allocations, reserved until payroll is locked or paid.

Both tables are service-only with RLS enabled. All server reads must be scoped to
the authenticated company and worker, or an authorized approval step.

Historical Workforce advances and recorded recoveries are imported with stable
source keys and provenance. The 16 September People MANUAL_ADVANCE deductions
(₹50,000) remain payroll history only. They must never become paid principal.
Approved but unpaid requests must never produce payroll deductions.

New requests start from the People or Workforce profile and use operational
manager approval followed by Finance. A paid advance does not block a later
request. Pending or approved-but-unpaid requests do. The approver receives current
outstanding pay, current-month paid count/total, remaining advance principal and
reserved payroll deductions. Current capacity is rechecked before approval.

Bank confirmation queues existing Workforce publications for refresh and wakes
People's open-payroll refresh. The full Workforce calculator is also the source
of OneApp's advance deduction. Payroll documents and salary exports include
ADVANCE_RECOVERY. Processing bank instructions stay frozen; unpaid take-home
limits recovery and any remainder carries forward. Confirmed recoveries are
immutable, including when earlier payrolls are recalculated.

Legacy manual entry, import, reassignment and recovery endpoints return 410.
Legacy tables remain for historical evidence with application write grants
revoked. No bank transfer is initiated by either migration.

## Coordinated release

This change requires the matching `dropx-hrms` branch. Build and test Dashboard,
Ops, OneApp and People before cutting over. Apply only these named migrations to
the shared project `uimajyffojydenqsegjv`, in order:

1. `20261029115517_unified_paid_advance_ledger.sql` (additive foundation).
2. `20261029115529_unified_advance_cutover.sql` (transactional history import and integration).

Do not use blanket db push. Both migrations are tested twice with PGlite. Recheck
live legacy totals, bank evidence, request links and outstanding balances before
and after application. Activate the matching app releases together. Run an open
payroll refresh after the release and verify the unpaid ₹4,000 scheduled legacy
advance is excluded while the four paid People advances total ₹54,000.

Validation commands: `node scripts/test-unified-paid-advance-ledger.mjs`,
`node scripts/test-unified-advance-cutover.mjs`, and
`node --experimental-strip-types --test src/lib/workforce-paid-advances-allocation.test.mjs`.
The broader Workforce payout regression suite remains required.

Rollback must preserve bank-confirmed principal and confirmed recoveries. Do not
re-enable old manual writes or restore old recovery scheduling over the new ledger.
