# Worked ID review

Open **Workforce → Worked ID review** on OpsPulse, or **Worked ID review** on Dashboard. Access follows the existing ID Mapping permission and location scope; saving requires edit access.

All permitted stations load by default. Region, cluster and station filters support search and multiple selections. Choose Associate view to review several dates together, or Day view for individual cases. Reasons distinguish no own ID, no recorded own-ID deliveries, and missing station delivery reports. This is a mismatch, not proof of absence; the reverse case (deliveries without biometric attendance) is outside this desk.

Only DA, DCD, ODCD and WM (Wish Master) with a positive MG_PER_DAY, MG_PER_MONTH, FIXED_PAY_PER_DAY or FIXED_PAY_PER_MONTH component effective on the work date enter the queue. Sorters, other roles, pure variable pay, van rent, fuel and kilometre components alone do not qualify. Fixed salary plus fuel or variable components does qualify. Transfers are checked across stations before creating an exception.

For each day, confirm with the station team:

1. **Worked using another ID:** search the actual provider ID or mapped name. If the owner also worked, split deliveries and other counts. If the owner did not work that day, assign the remaining work and exclude the owner's attendance pay, including MG/salary. Conflicting work, training or manual attendance prevents absence until resolved. Both associates' affected payouts refresh.
2. **Not worked — mark absent:** exclude this day's attendance from financial calculations. Raw punches remain unchanged.

**Buddy training** is a separate exception, offered only on/after DropX registration within that same IST month. At most two pending/approved training days are allowed across the associate's history, never reset monthly. Select a different buddy with recorded deliveries and a biometric punch that day. Pending or rejected training excludes attendance pay. The assigned Cluster Manager approves; the existing hierarchy falls back to AOM (including where the CM raised the request). Self-approval is blocked, including linked People identities. Approval restores attendance under the trainee's own fixed terms, without moving the buddy's counts. Reopening training into unapproved paid attendance is blocked.

The review shows dated configured payment components and current calculated daily earnings from the shared payout engine, before deductions. Fixed MG/salary follows each person's own terms and reviewed attendance; delivery-linked components follow reviewed counts and existing rates/thresholds. Borrowing an ID never supplies the borrower's rate. Kilometre inputs remain in the distance workflow.

For multiple days, apply a common decision, provider ID, owner-worked answer or reason, then edit individual dates as needed. Each date uses its own report and expected version. The entire batch is transactional: an invalid day rolls back all selected days. Shared counts must be entered per day; full-count assignment uses each date's actual remaining quantities.

After saving, both affected associates' live workforce calculations update. Existing published payout snapshots are queued for refresh and the screen reports if refresh is pending. Check Workforce Payouts before bank export. One earnings and CPS workforce costs read the same adjusted financial facts; operational punches and shipment reports retain the original evidence.

**Reopen** restores the unreviewed calculation and removes this review's shares. Every change keeps an immutable before/after event with actor and timestamp. Existing paid, approved or bank-processing dates are locked. Imported attendance/production inputs, ad hoc payments, ambiguous ID ownership, and conflicting shared-day answers must be resolved before a conflicting review can save. Later source replacement or mapping changes require reopening the related reviews first.

No historical days are automatically approved or excluded by deploying this feature. Station reviewers make those factual decisions. Training and review events retain actor, timestamps and before/after state. Active training protects its registration date, delivery evidence and linked biometric identities from silent replacement.

## Validation

`node scripts/test-worked-id-review.mjs` applies the migration twice to PGlite and exercises count conservation, multiple borrowers, stale versions, reopening, attendance exclusion, conflicting imports, mapping/source protection, finalized payout locks and private RPC access. The fixture schema contains column definitions only, with synthetic records created by the test.
