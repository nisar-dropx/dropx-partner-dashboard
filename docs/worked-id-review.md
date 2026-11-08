# Worked ID review

## Daily ID usage within ID Mapping

`/provider-id-mapping?view=days` is a section of the existing ID Mapping menu. It defaults to the previous month and all permitted stations. Search and multi-select region, Cluster/AOM and station filters apply to associate and provider-ID views. Expand an associate or provider ID to see effective mapped dates, provider name, registered owner, actual allocated worker, biometric evidence, bulk-period attendance, remaining/reassigned delivery quantities, payment method and locks. Current calculated earnings and dated rate components remain available in the review drawer.

Daily mode includes mapped days even when there is no punch or delivery. Only delivery roles with their own effective payment terms may allocate work. Unlike the exception queue, a daily recipient may have variable pay or deliveries already on their own ID. Allocating production never creates attendance or transfers the owner's rate card. The exception queue retains its fixed-pay/no-own-delivery scope. Monthly bulk totals retain their period-only meaning.

Selected days must belong to one associate in one month (maximum 31). Validate runs the exact save transaction in a rolled-back subtransaction, then confirmation rechecks versions, source counts and payment locks before committing. Both participants' payout dependencies refresh through the existing ledger and publication workflow. Validation is not a quoted net-pay amount; payroll calculates using the configured rates, thresholds and deductions.

Ad hoc locks resolve company-wide canonical workforce/provider identity, including payments recorded at a different station. Paid, processing and approved payroll stays locked. A later ad hoc payment cannot bypass an existing worked-ID allocation by changing station. No historical payment is cancelled, transferred or marked paid by the deployment. Financial corrections to finalized records remain Finance work.

Migration `20261108173134_daily_id_usage_review.sql` adds private server-only read/validation/save functions and reuses the existing reviews/shares/events. `scripts/test-daily-id-usage.mjs`, invoked by the existing Worked ID test script, checks idempotence, validation rollback, variable recipients, own-ID deliveries, quantity conservation, unchanged attendance, stale edits, over-allocation, cross-station locks in both directions and RPC privileges.

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

**Bulk periods** compares an uploaded period's attendance quantity with distinct dates having deliveries on the associate's effective mapped IDs. Multiple IDs/reports on the same date count once. The non-negative difference is labelled days to review, never inferred absent dates. Biometric days are shown separately, not added to the uploaded total. Only the existing delivery-role/fixed-salary scope qualifies. Filters apply equally to periods. Hours, missing station reports, ambiguous mappings and unfinished periods remain explicit review conditions. No day-count shortfall is evidence only, not approval of who performed the work. The period details retain file/Excel-row provenance and mapped ID/name/date evidence. Corrections use the existing protected workforce payout input workflow; this comparison does not change attendance or pay.

Daily review explains when bulk period attendance overrides the day calculation and is settled on the period end, instead of presenting an unexplained zero as a missed punch.

`node --test src/lib/worked-id-bulk-period.test.mjs` checks count conservation, duplicate IDs/dates, period boundaries, missing evidence, fractional quantities and hours.

`node scripts/test-worked-id-review.mjs` applies the migration twice to PGlite and exercises count conservation, multiple borrowers, stale versions, reopening, attendance exclusion, conflicting imports, mapping/source protection, finalized payout locks and private RPC access. The fixture schema contains column definitions only, with synthetic records created by the test.
