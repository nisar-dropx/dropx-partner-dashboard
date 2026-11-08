# Loss clearance and payroll release

Workforce and Helper bank generation and re-download require a current release approval for every included station, salary month and payroll source. Team Ops → Losses → Payment release review and Finance → Loss Clearance show the same reviews. Period closure remains a separate control.

The review compares NL/SLP/station source cases, unresolved decisions, and exact recovery keys/amounts in the latest payroll publications or People run. Earlier unresolved cases remain visible. A station with no recorded cases still requires an explicit source-completeness review. Missing imports are not assumed to mean no losses.

SLP Manager, Sales Manager, National Head, Finance Manager and Managing Partner roles can approve within their existing station access. Unresolved cases or unapplied deductions require **Approve release with exception**, a reason, recovery owner and a follow-up date within 90 days. This records permission to release salary; it does not waive or close the recovery. **Withdraw release approval** blocks subsequent downloads.

People approvers review station payroll and choose **Send to Finance**. Finance reviews the salary, holds, loss deductions, bank-account ending, paid amount and unpaid balance, obtains loss clearance, and chooses **Approve payroll for payment** or **Return to People**. The submitter cannot approve their own Finance submission. Only Finance generates and re-downloads bank files. People retains salary reports and existing bank-result reconciliation/withdrawal tools.

Changed losses, deductions, pay, run release state or bank details invalidate approval. Payroll changes require resubmission. Existing bank files remain tied to their original payroll revision. Repeated generation with the same operation ID returns the same processing instructions; new operations cannot duplicate processing instructions. Paid amounts reduce the next payment, and salary holds already included in net pay are not deducted again.

The database uses service-only RPCs, tenant/station/actor checks, append-only decision events and a shared company loss lock. Insert guards protect legacy generation paths. Server routes also gate both re-download paths. Failure to read loss clearance blocks downloads. Saved files already outside the system cannot be recalled; existing processing payments must be reconciled before another file is generated.

Migration: `20261108142437_loss_payment_clearance_and_people_finance.sql`. Apply this single migration to the shared project; do not push unrelated migration history. Coordinate Finance, People and Dashboard releases. Tests: `pnpm run test:payment-release`, existing Workforce bank-format tests, People payroll bank/export/loss tests, and both products' release integrity checks. Synthetic tests never approve or issue production payroll.
