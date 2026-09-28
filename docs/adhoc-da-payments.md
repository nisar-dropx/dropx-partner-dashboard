# Adhoc DA / Wishmaster payments

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
