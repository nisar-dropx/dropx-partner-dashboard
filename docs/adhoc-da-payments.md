# Adhoc DA / Wishmaster payments

- Applies to new **Payment Requests**, payment head `ADHOC_DA`; Expense Requests are unchanged.
- Select a station, delivery work date, and DA name/provider ID. Search matches both name and ID. Options come from `cps_shipment_daily` for exactly that company/station/date.
- One canonical Workforce mapping must exist for the provider/station/work date. Missing, ambiguous and scientific-notation identities fail closed. Fix the source import or Workforce Provider Mapping, not the payment beneficiary name, to resolve these.
- Database snapshots identity and work date. Returned requests retain that identity. For an incorrect selection, cancel the unpaid request and create a corrected one.
- Pending, approved, processing, returned, cancelled or rejected payments do not create a deduction. `processed` / `paid` creates one approved `cash_recovery` adjustment, using the actual approved amount and reference `OPS-ADHOC-DA:<payment UUID>`.
- The deduction uses existing Workforce earnings/payroll calculation and snapshot posting. A unique source reference and immutable link prevent retry duplication. A payroll transition gate prevents confirmation of a stale snapshot missing a paid Adhoc deduction. Refresh/recalculate the draft if prompted.
- If the original work date falls in an already approved/paid payroll, the posting date moves to the day after that closed period (repeated for contiguous closed periods). Prior confirmed amounts are never rewritten.
- The original processed payment and its recovery cannot be silently edited/deleted; follow the existing reviewed payroll correction process for reversals.

## Reports

OpsPulse → Reports → Payments → Adhoc DA / Wishmaster payments. Choose Quick month or From/To, then stations, and Download Excel.

The range is **delivery work date**, not bank payment date. DA summary has delivered totals once per station/client/provider ID, requested and paid amounts, recovery awaiting payroll and recovery included in a payroll snapshot. Payment details include work date, request ID, DA ID/name, bank reference, payment status, posting date, deduction and payroll IDs. “Posted” does not imply the final payroll itself has been bank-paid.

Historical requests lacking a DA identity remain visible as unlinked. This release does not guess identities or backfill financial deductions.

## Verification / rollout

Run `pnpm verify:adhoc-da` and TypeScript validation. SQL tests use local PGlite, never real payments. Apply `20260923143000_adhoc_da_payment_tracking.sql` before promoting the UI; it is additive and leaves unlinked requests untouched. The shared payment database supplies the deduction to the existing Workforce engine without a separate Workforce UI release.
