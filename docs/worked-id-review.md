# Worked ID review

Open **Workforce → Worked ID review** on OpsPulse, or **Worked ID review** on Dashboard. Access follows the existing ID Mapping permission and location scope; saving requires edit access.

Choose October 2026 and a location. The queue contains biometric days with no deliveries under the associate's effective own IDs and an existing fixed pay setup. It includes fixed daily/monthly plans and fixed-plus-variable plans, regardless of designation. Transfers are checked across stations before creating an exception.

For each day, confirm with the station team:

1. **Worked using another ID:** search the actual provider ID or mapped name. Confirm whether its mapped owner also worked. If both worked, enter this associate's share of deliveries, returns, pickups and any assigned counts shown; the owner keeps the remainder. Multiple borrowed IDs and multiple borrowers are supported.
2. **Not worked:** exclude this day's attendance from financial calculations. Raw punches remain unchanged. This does not assign an absence automatically to the owner of a borrowed ID.
3. **Pickup / other duty:** retain attendance and record the duty. No delivery counts move.

Fixed MG/salary continues under each person's own dated payment terms. Delivery-linked components follow the reviewed counts and existing rates/thresholds. A borrowed ID never supplies the borrower's pay rate. Kilometre/fuel distance inputs remain in the existing distance workflow; this review does not invent kilometres.

After saving, both affected associates' live workforce calculations update. Existing published payout snapshots are queued for refresh and the screen reports if refresh is pending. Check Workforce Payouts before bank export. One earnings and CPS workforce costs read the same adjusted financial facts; operational punches and shipment reports retain the original evidence.

**Reopen** restores the unreviewed calculation and removes this review's shares. Every change keeps an immutable before/after event with actor and timestamp. Existing paid, approved or bank-processing dates are locked. Imported attendance/production inputs, ad hoc payments, ambiguous ID ownership, and conflicting shared-day answers must be resolved before a conflicting review can save. Later source replacement or mapping changes require reopening the related reviews first.

No historical days are automatically approved or excluded by deploying this feature. Station reviewers make those factual decisions.

## Validation

`node scripts/test-worked-id-review.mjs` applies the migration twice to PGlite and exercises count conservation, multiple borrowers, stale versions, reopening, attendance exclusion, conflicting imports, mapping/source protection, finalized payout locks and private RPC access. The fixture schema contains column definitions only, with synthetic records created by the test.
