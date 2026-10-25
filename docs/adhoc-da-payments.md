# Adhoc DA / Wishmaster payments

## Current work-date policy (25 October 2026)

OpsPulse and Dashboard share the payment form and Workforce calculation. The associate selector now reads Amazon or Flipkart imports according to the configured station provider. It returns the latest record for each distinct provider ID across import history, so a fortnightly report does not hide people absent on its final day.

For Flipkart ODH/MDH, **Wishmaster name not reflecting** accepts a required 12-digit FHR ID (stored as text, including leading zeroes) and optional name. Users can find the ID using Aadhaar search in Casper; this form does not collect Aadhaar. Amazon's fallback requires a provider ID as well. Database validation derives the provider from the station and validates imported rows against company, station and provider.

**Work date** is explicit and defaults to today in IST. New submissions use `adhoc_payout_policy=work_day`. Only `processed` / `paid` bank states exclude that provider ID's work at that station on that date. Pending/approved/processing requests do not exclude anything. Shipment imports remain unchanged; the payout calculation excludes the day's production, fixed/attendance pay and route fuel. Future imports/reimports match the saved provider ID/date, not the shipment row UUID. The zero-value daily line cites the paid request. Monthly attendance/production accumulation excludes the day; aggregate attendance spanning an excluded day requires dated inputs before publication.

No cash-recovery adjustment is also created for a work-day request. An existing paid request for that ID/date prevents a second paid ad hoc request. An identified worker/date already in finalized Workforce payroll requires Finance review. Paid transitions share the payroll company lock, bump the dependency revision and enqueue publication refresh, invalidating stale calculation reviews. Failure to read paid-day records blocks payout calculation.

Historical requests keep the original cash-recovery policy below. No paid record, existing deduction or finalized payroll is silently rewritten. Historical dates were defaulted at submission, so retrospective conversion requires a reviewed correction, not an inferred work date.

Verification: `pnpm verify:adhoc-da` includes migration-twice PGlite lifecycle tests and actual Workforce-loader calculations for Amazon/Flipkart, per-packet/fixed pay, approval-only, date isolation, legacy deductions and failed exclusion lookups. Apply only `20261025120000_adhoc_wishmaster_paid_days.sql` before deploying the new form. No requests are paid or approved by the migration.

## Historical cash-recovery policy


- Applies to new **Payment Requests** and **Submit payment details** for approved requests, payment head `ADHOC_DA`. The initial Expense Request form is unchanged. Existing prior-approval requirements remain enforced; the DA is captured at the payment step even when that modal is opened from the expense register.
- Select a DA name/provider ID from the latest available Amazon shipment roster for that company/station. The report date is not used. There is no date prompt or Workforce picker.
- **DA name not available** accepts the exact SCC name alone. Missing, ambiguous or malformed provider mappings do not block payment submission or processing.
- Database snapshots the reference identity; the internal recovery date defaults to submission day in IST. Returned requests retain that identity. For an incorrect selection, cancel the unpaid request and create a corrected one.
- Pending, approved, processing, returned, cancelled or rejected payments do not create a deduction. `processed` / `paid` creates one approved `cash_recovery` adjustment when the backend can uniquely resolve the payroll identity, using the bank transaction amount (`amount`, falling back to `amount_requested`) and reference `OPS-ADHOC-DA:<payment UUID>`.
- Paid/unmatched references remain visible as **awaiting identity reconciliation**, not recovered. The authenticated Ops payment scheduler retries up to 200 oldest-checked records per run when a mapping becomes available. Manual names resolve only through an exact, unique provider identity in the latest station roster, then a unique authoritative mapping. No similar-name guesses or browser-supplied Workforce IDs are trusted. Finance/People must resolve ambiguous source identities before recovery can be posted.
- The deduction uses existing Workforce earnings/payroll calculation and snapshot posting. A unique source reference and immutable link prevent retry duplication. A payroll transition gate prevents confirmation of a stale snapshot missing a paid Adhoc deduction. Refresh/recalculate the draft if prompted.
- If the original work date falls in an already approved/paid payroll, the posting date moves to the day after that closed period (repeated for contiguous closed periods). Prior confirmed amounts are never rewritten.
- The original processed payment and its recovery cannot be silently edited/deleted; follow the existing reviewed payroll correction process for reversals.

## Reports

OpsPulse → Reports → Payments → Adhoc DA / Wishmaster payments. Choose Quick month or From/To, then stations, and Download Excel.

The range is the internal **recovery work date**, not shipment report date or bank payment date. DA summary has delivered totals once per station/client/provider ID, requested and paid amounts, recovery awaiting payroll and recovery included in a payroll snapshot. Payment details include work date, request ID, DA ID/name, bank reference, payment status, posting date, deduction and payroll IDs. “Posted” does not imply the final payroll itself has been bank-paid.

Historical requests lacking a DA identity remain visible as unlinked. This release does not guess identities or backfill financial deductions.

## Verification / rollout

Run `pnpm verify:adhoc-da` and TypeScript validation. SQL tests use local PGlite, never real payments. Apply `20260928183000_adhoc_da_reference_only.sql` after the earlier Adhoc DA migrations and before deploying the updated form. It replaces the blocking guard and adds a service-role-only reconciliation RPC. The migration does not approve, process or pay any requests. Existing approvals, station scope, bank validation and the Workforce engine remain unchanged.
