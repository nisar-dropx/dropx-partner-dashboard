# Team Ops, People and payroll workflows (October 2026)

## Ad hoc bank confirmation before Workforce mapping — 29 October 2026

A missing Workforce mapping must not reject a bank-confirmed ad hoc payment.
For `work_day` requests, retain the immutable station, provider ID and work date;
the payout loader excludes that paid day using those keys even when mapping is
entered later. Never also create a cash deduction for a paid work day.
`reconcile_adhoc_da_recoveries()` now includes unresolved paid work-day requests.
The existing five-minute OpsPulse reminder job calls it; a unique effective-date
mapping links the payment and queues one payout refresh. Unresolved/ambiguous
identities remain paid and pending mapping. Duplicate payments and finalized
payroll guards remain enforced; closed-payroll conflicts remain for review.
Migration: `20261029210001_adhoc_paid_day_deferred_workforce.sql`.

## Recovery assignment and deduction display — 29 October 2026

People employees and contractors can be assigned recovery without a calculated salary.
Employment, station scope, allocation, schedule and exception checks still apply on save.
The People payroll engine enforces available take-home when deducting; unfunded whole
lines remain due. Workforce continues to check payout eligibility when saving.
Migration `20261029143000_loss_people_assignment_and_managers.sql` restores the mapped
Cluster Manager / AOM directory ceiling without exposing People pay amounts.
Migration `20261029160000_loss_parent_child_recipients.sql` adds the configured active,
same-provider EDSP/XPT parent–child scope to both the picker and save validation.
An XPT includes its EDSP parent, not sibling XPTs. The picker shows source station codes
and deduplicates people by recovery reference. Higher management stays excluded.

Workforce and People show one expandable loss total. Underlying recovery keys remain
individual, so history, carry-forward and exactly-once deductions are unchanged. Payslips
show one **Loss Recovery** line. DropX One assignment notices expire after seven days
and leave the home screen as soon as read; shipment details remain in Salary Calculation
or Payments.

## Live payroll refresh — 28 October 2026

Routine recovery saves require no separate approval. Individual saves/removals and bulk workbook
updates notify People through `/api/internal/loss-payroll-refresh` with a company-scoped,
purpose-bound, one-minute HMAC. People uses its existing payroll calculation engine for changed
open runs and compares run, due-line and bank-state versions before committing. Closed payroll and
issued/paid figures stay protected. A failed refresh is shown as pending without failing the saved
recovery. An open editable People payroll page retries automatically every 30 seconds.

Release dependency: apply HRMS migration `20261028233000_loss_payroll_live_refresh.sql` individually
and deploy People before this relay. The station recovery table shows draft payroll separately;
draft amounts remain included in pending recovery until payroll confirms the deduction.
Workforce's monthly payout loader already reads `nl_loss_recovery_due` on each calculation.

A guide for developers and AI agents working on loss recovery, station loss claims, salary holds,
offboarding money checks, payout disputes, payout cross-checks, the COD cash position, the delivery
scorecard and training written answers. It explains how each piece works, where the code and database
objects live, the rules that must not be broken, and the work still open.

The partner dashboard (this repo) and People/HRMS (`dropx-hrms`) share **one Supabase project**
(`uimajyffojydenqsegjv`). Tables created in one repo are read and written by the other, so a change to a
shared table, function or status value must be checked in both repos.

## Ground rules

- **Money moves only through payroll.** A loss, a salary hold or its release changes pay only by appearing
  in an HRMS payroll run (`hr_payroll_run_items`) or a published Workforce payout
  (`workforce_payout_publications.snapshot`). Never write amounts anywhere else.
- **Exactly once.** Every Ops loss deduction carries a `recovery_key`. A key that any other payroll
  already carries is never due again. Keep the key formats below stable: they are stored in payroll
  history.
- **State changes go through one database function per workflow.** That function enforces the state
  machine, the version (no lost updates) and that nobody decides their own request, and it writes an
  append-only history row. Do not `update` status columns directly from app code.
- **The app decides who may act; the database decides what may happen.** Approver checks (cluster manager
  of the station, permissions, station scope) are done on the server for every request and never trusted
  from the client. The database function then refuses invalid transitions.
- **Migrations are applied one file at a time.** Many local migrations in this repo are not in the remote
  history under the same version, so a blanket `supabase db push` is unsafe. Apply a single file with
  `supabase db query --linked -f <file>`, then record it with
  `supabase migration repair --status applied <version> --linked`. Check that the version number is not
  already used by another file in either repo.
- **Every migration must be safe to run twice.** Each one has a PGlite test that applies it twice.

## Loss recovery (Team Ops → Losses)

Files: `supabase/migrations/20261015130000_loss_recovery_payroll_deductions.sql`,
`20261016161000_loss_recovery_installments.sql`, `20261022120000_nl_slp_loss_lifecycle.sql`,
`20261022121000_loss_recovery_action_digest.sql`; `src/lib/ops-pulse/nl-loss-policy.ts`,
`nl-loss-lifecycle*.ts`, `nl-recovery-payables.ts`, `nl-recovery-ledger*.ts`;
`src/components/nl-loss-cases.tsx`, `nl-recovery-ledger.tsx`;
`src/app/api/ops-pulse/losses/recovery`, `.../lifecycle`, `.../ledger/write-off`;
`src/lib/workforce-loss-recovery.ts` (Workforce payouts); DropX One
`apps/connect/.../loss-recoveries` + `connect-loss-recoveries.tsx`;
HRMS `src/lib/payroll-ops-loss-recovery.ts`.

**Full live lifecycle (states, access, digests, rollout):** see
[`docs/nl-slp-live-loss-lifecycle.md`](./nl-slp-live-loss-lifecycle.md).

```text
imported → station_dispute_or_clarification_window → cluster_validation_pending
  → slp_final_confirmation_pending → recovery_approved_scheduled → recovery_in_progress → recovered
Exceptions: returned_to_station | rejected | not_recoverable | on_hold | needs_review | exit_balance | written_off
```

Cases come from Amazon (NL, SLP Final) or from approved station claims (`report = 'station'`), all in
`nl_loss_month_cases`. A plan in `nl_loss_recoveries` assigns the full case amount to up to 50 people
(employees `employee:<id>` → HRMS payroll; Workforce `workforce:<id>` → Workforce payout).
**Allocating plans are `proposed` until SLP final approval** (`nl_loss_recovery_approve`); only
`approval_status = approved` lines are returned by `nl_loss_recovery_due`. Legacy in-flight plans were
backfilled to `approved`. Station users dispute/clarify only (Cloak NL disputes + `nl_loss_clarifications`);
Cluster Managers propose; they cannot approve their own proposal.

**Recovery mode** (`nl_loss_recoveries.recovery_mode`):

- `full`: one deduction per person. Key `month|case|ref`, unchanged from before, so old payroll history
  still matches.
- `installments`: each person's share becomes a schedule stored on the allocation (`installments`:
  `[{n, amount}]`, plus `monthly_amount`). Basis is `months` (2 to `max_installments`, default 24; remainder
  paise go on the first instalments) or `amount` (fixed monthly amount; the last instalment is smaller).
  Key for instalment n: `month|case|ref|n`.

**What is due** (`nl_loss_recovery_due(company, salary_month, target, run)`):

- Never before `recovery_policy.payroll_start_month` (2026-10). September 2026 payroll gets nothing.
- One instalment per person per plan per payroll: instalment n is due only when n-1 is already in an
  earlier salary month. A missed month shifts the remaining instalments; it never doubles up.
- **Exit:** if the person's `last_working_date` is on or before the end of the salary month, every
  remaining instalment is due in that final settlement, marked `final_settlement` and `cap_exempt`.
- A plan whose source amount or status changed waits for review in Losses and is not deducted.
- Written-off lines (`nl_recovery_waivers`) are never due again.

**Debit directory scope:** Current station staff, Workforce and the mapped Cluster Manager /
AOM are eligible; the reporting walk stops at AOM. Higher management stays excluded.
People salary amounts never leave the server in the recovery picker. Assignment does not
require a calculated People run; payroll applies available-pay limits when calculating.

**Already recovered:** `mayMarkAlreadyRecovered` — Cluster Manager / City Manager / AOM and above
(or SLP / NH / Finance / MP redispute roles). Station and under-managers with Losses edit do **not**
see or set the “Already recovered” outcome.

**Salary cap:** `recovery_policy.salary_cap_percent` (50) of take-home, applied twice:

1. When saving, against last month's payable, on the **monthly** amount. The payable comes from
   `nl_recovery_payables`, which also stores `gross`; a monthly amount above gross is refused.
2. In payroll (`fitOpsLossRecoveries` in HRMS, `applyWorkforceLossRecoveries` here), on the real
   take-home.

A plan with `cap_override` (reason required, Loss Recovery Master edit permission only) and exit lines may
use the whole take-home. Lines are never part-deducted; a line that does not fit stays due.

**Locks:** once a reviewed HRMS run or a published payout carries any line of a plan, that person's
amount, the schedule and the timing cannot change, and the plan cannot be removed
(`nl_recovery_locked_lines`).

**Ledger and write-off:** `nl_recovery_ledger` returns one row per person per plan: total, deducted
(reviewed or published payroll only), in a draft payroll, written off, outstanding and status
(`scheduled | in_progress | recovered | needs_review | exit_balance | written_off`). The Recovery Ledger
tab shows it. `waive_nl_recovery_balance` writes off only an exited person's outstanding balance, never
an amount already in a draft payroll, needs a 10-character reason and Loss Recovery Master edit access,
and is logged in `nl_loss_recovery_events`.

## Station loss claims (Team Ops → Losses → Station Claims)

Files: `supabase/migrations/20261016181000_station_loss_claims.sql`;
`src/lib/ops-pulse/station-claims*.ts`; `src/app/api/ops-pulse/losses/claims/route.ts`;
`src/components/station-claims-desk.tsx`. The old `/attendance/workforce-losses` page shows the same desk.

```
station raises → submitted → (cluster manager) approve → approved → loss case → recovery plan → payroll
                    │  ├─ return → returned → (raiser) resubmit → submitted
                    │  └─ reject → rejected
                    └─ (raiser) withdraw → withdrawn
```

- Tables: `ops_station_loss_claims` (unique `reference` per company, version column),
  `ops_station_loss_claim_events` (immutable). Functions: `station_claim_submit`, `station_claim_transition`.
- The approver is the cluster manager of the claim's station from the People hierarchy, or the Area
  Operations Manager when no cluster manager is mapped (`holdApprovers` in `salary-hold-policy.ts`). The
  raiser can never decide their own claim.
- Approval creates the case `station:<REFERENCE>` in `nl_loss_month_cases` with `report = 'station'`,
  `source_status = 'Approved'`. `nl_case_recoverable` treats it as recoverable, and the NL/SLP import jobs
  only touch their own report, so a station case is never overwritten by an Amazon import.
- The legacy `workforce_station_loss_claims` / `workforce_adjustments` flow was not read by the current
  Workforce payout loader, so it was replaced. It held 0 claims when replaced and still holds 0 rows.
  The portal and request-tracker catalog now use `ops_station_loss_claims` only. Do **not** drop
  `workforce_station_loss_claims` without a separately approved archival migration; keep it read-only.

## People salary hold (Team Ops → Salary Hold; HRMS payroll)

Files: HRMS `supabase/migrations/20261016170000_salary_hold_approvals.sql`,
`src/lib/payroll-standing-holds.ts`, `src/lib/payroll-data.ts`, `src/app/(hrms)/payroll/actions.ts`;
dashboard `src/lib/ops-pulse/salary-hold-*.ts`, `src/app/ops-pulse/attendance/salary-hold/actions.ts`,
`src/components/ops-salary-hold.tsx`.

```
raise → awaiting_approval → approve → pending → (payroll) applied → request_release → release_requested → approve_release → released
            ├─ reject → rejected          └─ request_cancel → cancel_requested → approve_cancel → cancelled
            └─ withdraw → cancelled                                         └─ reject_cancel → pending
```

- Raised by Senior Store Manager and above for a current direct report. It is decided by the station's
  cluster manager (AOM fallback), never by the person who made the request. HR can still decide
  cancellations in HRMS through the same function.
- Functions: `ops_salary_hold_raise`, `ops_salary_hold_transition`, `ops_salary_hold_record_payroll`.
  History: `ops_salary_hold_events` (immutable).
- Payroll (`planStandingHolds`):
  - `pending` holds are withheld.
  - A hold already applied to this run is withheld again on every recalculation. Before this fix,
    recalculating dropped it.
  - `released` while its own run is still draft or calculated drops out of that run.
  - `released` after its run was submitted is paid back once as an earning (`SALARY_HOLD_RELEASE`) in the
    next later run, then `release_run_id` is set.
- Payroll only ever reads `pending`, holds applied to the current run, and `released` holds. It never
  reads `awaiting_approval`, so nothing is withheld before approval.

## Offboarding money check (HRMS → Exits)

Files: HRMS `src/lib/exit-financial-clearance.ts`, `src/app/(hrms)/exits/[id]/page.tsx`,
`src/app/(hrms)/exits/actions.ts`.

The case page shows **Money owed and held**: outstanding Ops loss lines (from `nl_recovery_ledger`) and
open salary holds. Closing, or submitting with pending clearance, while either is open needs a written
note (`financial_ack`, 10–500 characters). The note and the open items are saved as the case event
`FINANCIAL_CLEARANCE_ACKNOWLEDGED`. If the shared database lacks these features, the panel stays empty and
never blocks an exit.

## Payout disputes (Payments → Payout Disputes)

Files: `supabase/migrations/20261016190000_payout_dispute_approval.sql`,
`20261020100000_payout_dispute_processing_workflow.sql`,
`20261020110000_payout_dispute_legacy_adapter_cleanup.sql`, `src/lib/payout-review-actions.ts`,
`src/components/payout-review-desk.tsx`, `src/app/settings/payout-disputes`.

```
open → (initial approver) propose exact correction/rejection → pending_final_approval
  ├─ (final approver) reject → rejected
  ├─ (final approver) send back → open
  └─ (final approver) approve correction → approved_for_processing
       → (processor) claim → processing → apply correction and publish revised payout
                                   → verify publication/net change → resolved
                                └─ block with reason → processing_blocked → claim again
```

- Configure ordered primary/fallback roles at **Settings → Payout Dispute Workflow**. A company default
  is required and individual stations may override it. Initial approver, final approver and processor
  are independent roles and three different people are enforced. No SLA is configured.
- Function `workforce_dispute_transition_v2` enforces ordered role readiness, location scope, distinct
  actors, optimistic versioning and the state machine. Every transition is an immutable,
  version-numbered `workforce_payout_dispute_events` row.
- A correction proposal records the exact field/current/corrected value and expected net-pay delta.
  Final approval never marks that correction resolved. The processor must change the authoritative
  payout input and publish a newer revision for the same person, station and period. The processor
  attests that the approved field change was applied; completion independently verifies the newer
  publication, its before/after net values and the exact approved net delta.
- Open disputes are excluded per station row from new Workforce bank instructions. Existing paid or
  partially paid history is never rewritten, and a payout already in bank processing must be finalized
  or cancelled before a processor can claim its correction.
- DropX One shows the associate the current stage, processor-applied correction and system-verified
  publication/net result. Older already-closed records are labelled as legacy/unverified because no
  revised publication was linked.
- The portal calls `workforce_dispute_transition_v2` only (`src/lib/payout-review-actions.ts`).
- `20261020100000` and `20261020110000` are applied remotely: execute is revoked on both
  `workforce_decide_payout_dispute` and the rolling adapter `workforce_dispute_step`.
- `workforce_decide_payout_dispute` may still exist as a definition with no grants. Drop it only with
  the separately named approval-gated migration `20261021140000_drop_workforce_decide_payout_dispute.sql`
  after confirming no runtime callers remain in Dashboard, HRMS, or Ops.
- The desk loads only the publications referenced by the disputes shown. Do not go back to loading the
  whole publication history.

Deployment status (2026-10-21): processing workflow + adapter-grant cleanup are already on the shared
project. Portal release uses v2. Remaining optional step: apply `20261021140000` only after explicit
approval to drop the unused one-step function.

## Workforce payout cross-checks (Payments → Workforce payouts)

Files: `src/lib/workforce-payout-checks.ts`, `src/components/workforce-payout-checks.tsx`.

Monthly view only. The checks run on the rows the page already loaded (no extra queries):

- **Critical:** pay changed after associate review, pay without work days, bank details missing.
- **To review:** deductions above gross, gross per day above `DAY_RATE_CEILING` (₹2,500), work without
  pay.

Bank-file generation separately recalculates every selected amount from live inputs with a dependency
hash, so a stale amount can never be paid.

## COD cash position (COD → COD Reports)

File: `src/components/cod-cash-position.tsx`, used in `src/app/ops-pulse/cod/reports/page.tsx`.

The strip shows collected (final Executive Reconciliation) → awaiting deposit → deposited → verified →
issues, all as amounts, plus the collected-versus-deposited gap. It uses data the page already loads.

## Delivery scorecard (Delivery Performance → Scorecard)

Files: `supabase/migrations/20261016200000_delivery_scorecard.sql` (`ops_delivery_scorecard`),
`src/app/ops-pulse/edd/scorecard/*`.

- One read-only database call aggregates `cps_shipment_daily` for the period and the previous equal
  period, at most 92 days, using the station/date index (about 0.5 s for 30 days).
- Station rows show deliveries, change, DAs, per-DA-per-day, return rate and trend. Each station expands
  to a DA leaderboard; DAs under 60% of the station average are highlighted.
- Delivery success % is returned only when `assigned_count > 0` for the rollup; otherwise the UI shows
  “Not available from source data”. Flipkart cycle imports supply assigned; live Amazon shipment files
  do not include an assigned column, so Amazon rows stay at 0 unless a future Amazon export adds one.
  Reimports must not overwrite a positive assigned value with a missing/default zero.

## Training written answers (DropX One + HRMS → Training)

Files: HRMS `supabase/migrations/20261016210000_training_written_answers.sql`,
`src/components/training-written-marking.tsx`, `src/app/(hrms)/training/*`; dashboard
`apps/connect/app/api/connect/training/route.ts`, `apps/connect/src/components/connect-training.tsx`.

- Tests that contain text questions can now be taken in DropX One. `hr_training_submit_written` scores the
  choice questions, stores the written answers in `hr_training_written_submissions` (one pending per
  test) and sets the milestone `in_progress`.
- The trainer gives marks per written answer in HRMS (`hr_training_mark_written`). The total goes through
  `hr_training_record_assessment`, so pass %, attempt limits and enrolment status work as for any test.
  A person cannot mark their own test.
- Training is set up but barely used (one programme, no enrolments as of 2026-10-16). Adoption needs
  programmes, milestones and questions created in Training Master.

## Workforce payment holds (Team Ops → Workforce holds)

Files: `supabase/migrations/20261017100000_workforce_hold_requests.sql`, `src/lib/ops-pulse/workforce-hold-data.ts`,
`src/app/api/ops-pulse/workforce-holds/route.ts`, `src/components/workforce-holds-desk.tsx`.

```
raise → awaiting_approval → (cluster manager) approve → active → (raiser) request_release → release_requested → approve_release → released
            ├─ reject → rejected                                                      └─ reject_release → active
            └─ withdraw → cancelled
```

- **How a hold takes effect:** approving calls `workforce_set_payout_payment_hold` for that calendar month,
  in the same transaction. That is the real hold the Workforce payout worksheet and the bank file honour.
  Approving the release lifts it.
- **Old table:** the previous page wrote to `workforce_payment_holds`, which payouts never read. That table
  is no longer written.
- **Bank processing:** a hold cannot change while that month's payment is `processing` in
  `workforce_payout_payment_items`, which is the same rule the Payments page applies.
- **"On hold now":** the desk shows the latest hold events in `workforce_payout_payment_hold_events` for
  people at the viewer's stations, including holds placed from Payments.
- **Picking people:** associates load per station on demand; the page never reads the whole workforce.

## Approver rule shared by holds and claims

`holdApprovers` (`salary-hold-policy.ts`) returns the station's cluster managers, falling back to the Area
Operations Managers when no cluster manager is mapped. The person who made the request is always excluded,
so a cluster manager's own request goes to the AOM.

**Acting / unavailable cover:** when a CM or AOM stops reporting, People sets an acting cover in HRMS
Approval Workflow Master (`hr_approval_delegations`). Ops Pulse loaders (`loadActiveApprovalCovers`) remap
that person to their acting cover for holds and station claims, and SSA routing does the same. Pending
DropX One / People steps are shifted when the cover is saved; closing the cover restores only steps that
still record the original person.

People salary holds can be raised for a direct report, or for any active employee or contractor at a
station in the viewer's Ops scope (`holdTargetAllowed`). Station people load on demand.

## Offboarding checklist scope (Team Ops → Offboarding)

The page shows every open exit for people at the viewer's stations, plus the viewer's direct reports, with
steps waiting for the viewer first. The approve action (`actions.ts`) re-checks the reporting-chain level
for every gate, so a wider list never gives anyone extra approval rights.

## Load and caching notes

- **COD Reports:** always uses a bounded range (default the last 14 closed days, at most 92) and lean
  columns (`lean: true` in `loadCodSubmissions`), with 50 rows per page.
- **Delivery scorecard:** the database aggregate is cached for 10 minutes per company, station set and
  range (`unstable_cache`). Errors are not cached.
- **DropX One training:** `GET /api/connect/training?summary=1` returns only a count of open enrolments. It
  drives the home card and the Training tab badge.

## Tests

- Dashboard: `pnpm run test:loss-recovery-payroll` and `pnpm run test:salary-hold`. Both run in
  `prebuild`, and they cover the PGlite migration tests for losses, station claims and disputes.
- HRMS: `payroll-ops-loss-recovery`, `payroll-standing-holds`, `salary-hold-approvals-sql`,
  `exit-financial-clearance` and `training-written-answers-sql` (vitest).
- Locally on Windows, `scripts/test-station-audit-progress.mjs` fails because it writes to `C:\tmp`. That
  is unrelated to this work and passes on Vercel.

## Pending work

- **NL/SLP lifecycle — production walkthrough completed 2026-10-22.** Digest dry-run verified, live NL
  + SLP Final propose→approve→due completed, Initial-only refused, cap override / two-month / pre-publish
  lock spot-checked, then `delivery_ready` + digest enabled. Record:
  [`docs/nl-slp-ops-enablement.md`](./nl-slp-ops-enablement.md) §4.
- **Automatic ID mapping by email** (workforce register and LSC ↔ DropX IDs). This is blocked: LSC
  provider IDs (`2000…`, from `cps_shipment_daily`) have no email anywhere in the database, and the Amazon
  transporter IDs linked by email in `workforce_amazon_portal_links` are a different ID system. It needs a
  source with LSC ID and email (for example an LSC site export), or an agreed name-plus-station suggestion
  rule.
- **Reports** (on-screen numbers and layout) and **network planning** (LSC site). Waiting for the business
  to describe the pain points.
- **Mileage claims.** There are no station policies yet, and the Ops page has no review step (no `review`
  action is passed to the mileage desk). Approved claims go to `workforce_adjustments`, which Workforce
  payouts do not read, so they would not be paid today. Wiring them into the payout needs a decision.
- **Training adoption (business).** HRMS Training Master now has a readiness checklist and an optional
  **draft-only** starter programme shell. Business owners still need to supply real programme content,
  audience, materials, question banks and the publish decision. Nothing auto-publishes or auto-enrols.
- **Clean-up (technical, approval-gated).**
  - `workforce_decide_payout_dispute`: grants already revoked; drop via `20261021140000` only after approval.
  - `workforce_station_loss_claims`: 0 rows, no portal writes; catalog points at `ops_station_loss_claims`.
    Do not drop the legacy table without a separate archival decision.
- **Data quality.** Amazon assigned counts remain unavailable from source files. Flipkart assigned counts
  are imported. Scorecard shows delivery success % only when assigned > 0.

## Migration runbook (shared Supabase — never blanket push)

Apply one file at a time after tests pass:

1. `supabase/migrations/20261022120000_nl_slp_loss_lifecycle.sql` — case lifecycle + propose/approve gate.
2. `supabase/migrations/20261022121000_loss_recovery_action_digest.sql` — daily digest control (disabled).
3. `supabase/migrations/20261021120000_delivery_scorecard_assigned_success.sql` — scorecard success % (if not yet applied).
4. `supabase/migrations/20261021141000_station_claim_request_tracker_catalog.sql` — catalog pointer update (if not yet applied).
5. **Only with explicit approval:** `supabase/migrations/20261021140000_drop_workforce_decide_payout_dispute.sql`.

For each file:

```text
supabase db query --linked -f <file>
supabase migration repair --status applied <version> --linked
```

Already applied (do not re-apply): `20261019101000`, `20261020100000`, `20261020110000`,
`20261016200000`, `20261016190000`.

## Current loss mail preview and manual send (2026-10-24)

Notification Settings → Loss recovery → Preview current report / send to me uses
`loss-daily-data.ts`, `loss-daily-snapshot.ts` and `loss-daily-mail.ts`. It reads every
recorded loss period in the signed-in user's permitted station scope, using current People
CM owners (AOM fallback), stage-aware NL replies, SLP Initial / Final separation,
station claims and the payroll ledger. Internal response/plan deadlines remain explicitly
unconfigured; only published Amazon stage deadlines produce overdue flags.

The Excel has Station Summary, Case Actions and Person Recoveries. Only approved plans
enter recovery balances. Draft payroll is separate from recovered amounts, and current
payroll eligibility is before salary caps. Source failures stop the send; stale source
checks appear in the report. No recovery or payroll records are modified.

The preview endpoint's POST sends only to the signed-in account (Notification Settings
edit + Losses access, no impersonation), with an Excel attachment and an SMTP receipt.
A unique `loss_recovery_manual_<user ID>` event/day prevents duplicate sends, including
uncertain deliveries. Accepted messages reply within that user's monthly thread.
It never enables a schedule or accepts arbitrary recipients. Manual receipts appear in
the loss delivery history.

The existing scheduled loss digest was disabled on 24 October at the user's request.
Recipients and timing are awaiting their decision. Its legacy recipient builder is
separate from this manual report and must be reviewed before enabling broad delivery.


### Recovery deductions in DropX One (2026-10-25)

- Approved plans already enter `nl_loss_recovery_due` and reduce net pay in People payroll calculation and full-month Workforce payout calculation. Saving a proposal does not bypass SLP approval. Closed payroll stays unchanged; unapplied keys remain due for a later eligible calculation, subject to existing caps and instalment rules.
- DropX One keeps completed recovery history, including deductions on plans later paused for review. Each salary/published payout loss line opens an own-account detail dialog with tracking ID, case amount, allocated share, this payroll's amount, confirmed deducted total, provisional draft amount and outstanding balance.
- Workforce published deduction presentation groups losses by recovery key rather than merging all losses under one code. New raw snapshot lines retain the key too; old worksheet snapshots already contain it. Keys are never derived from an unverified name.
- `scheduledFromMonth` is the eligibility start, not a promise of the next payroll month. Unpaid/outstanding includes provisional draft deductions until payroll confirmation.
- Regression: `node scripts/test-connect-loss-recoveries.cjs`, the loss payroll suite, and Connect's `published-payout-breakdown.test.mjs` / `interim-salary.test.mjs`.

## Exception-only approvals — 27 October 2026 (supersedes universal approval)

Full allocation in the Master outcome's `current_month` timing, full debit mode, and no cap override becomes payroll-eligible automatically after the existing source, station directory, current payable, full-allocation and payroll-lock validations. This is eligibility for the next applicable payroll calculation, not an immediate salary transfer. The normal payroll cutoff still determines the deduction month.

Departed/inactive people, next-month timing, instalments, cap overrides and receipt verification require independent approval. Source changes and returned corrections also require approval; repeated saves cannot bypass that review. SLP Manager, National Head, Finance Manager or Managing Partner can approve within their page permissions and location scope. Proposers cannot approve their own exceptions.

`20261027183000_loss_exception_approval.sql` patches the atomic writer. Automatic decisions have a null human approver and an explicit system label. Existing decisions are preserved; saving a routine proposal with refreshed eligibility applies the new rule. Production preflight found two approved plans and no pending proposals. No payroll history, published payout or recovery key is rewritten.

The Recovery review groups scoped allocations by station, person or saved designation. Assigned, actually deducted, draft-payroll and outstanding amounts remain separate; pending review is a subset of outstanding, not an additional charge. Redisputes and Station claims remain under More. Actions and timing remain configured in Loss Recovery Master.


## Directory, payroll month and redispute release — live 27 October 2026

**Release status: live.** Both migrations below were applied individually and verified in production.
OpsPulse and One production builds were promoted; the companion HRMS contractor payroll change
(PR45, main commit `70fa29cc`) is production READY. OpsPulse/One changes are merged in PR398
(main commit `76806fc9`). No production financial test records were created.

- `20261027203000_loss_people_payroll_month.sql`: canonical station People + Workforce directory,
  contractors, current CM/AOM reporting chain, configurable ceiling/exclusions in Loss Recovery Master;
  actual payroll-month debit report; current payroll with a fifth-day inclusive cutoff. Loss month and
  payroll month remain separate. Explicit later payroll requires exception review.
- `20261027210000_loss_redispute_review.sql`: Shipment ID activation, evidence, independent review,
  post-dispute ticket and final outcome. Single and bulk activation require **SLP Manager, National Head,
  Finance Manager or Managing Partner**, plus Losses edit permission and station scope. Master ownership,
  GM, CM, AOM and station roles alone cannot activate. Managing Partner is the role used for Jamsheer;
  no email/name-based bypass is introduced.
- Bulk activation: Excel template, up to 100 shipments, preview and per-shipment outcome. Each row checks
  scope and optimistic version again on the server. Duplicate/malformed batches are rejected before writes;
  a valid mixed-scope batch returns failures for inaccessible rows without activating them.
- Activation needs no station justification. Ground submission requires remarks, reason, ticket reference
  and an HTTPS footage/evidence link. A different authorised reviewer approves/returns it. Final outcome
  and post-dispute TT remain in the same append-only history.
- Active redispute pauses future payroll. Won stops the remaining collectible balance without pretending
  it was deducted or refunding historical payroll. Lost resumes in the selected open payroll month
  (default next month), retaining original recovery keys. Ordinary plan edits cannot bypass these gates.
- Recovery presents confirmed debits by station/person/actual payroll month, separate draft amounts,
  nested Shipment IDs, monthly history and Excel export. Final NL/SLP totals distinguish updates from
  pending updates; dispute savings are not recovery-plan updates.
- One exposes only the signed-in person's assignment, proposal status, share and actual payroll history.
  Employees, contractors and Workforce remain typed identities. Earlier deductions remain visible during
  a later review or redispute; outstanding is not a new additional charge.

Validation: full `test:loss-recovery-payroll` suite, including both migrations applied twice in PGlite,
API role/bulk/scope tests, lifecycle and payroll gate tests, own-account One tests and reporting tests.
Targeted OpsPulse and One TypeScript checks and production builds pass. Live verification confirmed
KLZA has 58 eligible names including People roles and its cluster manager, September losses select
October payroll, NL Final totals and the month/person Recovery report render correctly, and Redisputes
exposes single activation and the bulk template. The fifth/sixth-day IST boundary, migration source hashes
and old/new RPC grants were verified. The HRMS companion uses existing fitting/cap rules for contractors;
its 11 payroll tests, TypeScript and release-integrity checks passed.

Release order: inspect live schema and migration history; prepare successful builds for OpsPulse, One
and HRMS; apply each migration individually with the existing runbook; promote the coordinated builds;
verify read-only station directories and role visibility. Do not create financial test records in production.
The redispute migration revokes the old mutation RPCs, so avoid leaving the old app serving writes after
that migration. Do not use a blanket database push.

### Stage reminders and recurring amount rules (28 October 2026)

- Loss reminders run at 11:00 / 16:00 IST through the existing five-minute notification cron.
  Recovery-update reminders run 20th–next 5th; initial NL dispute reminders 7th–11th;
  station responses to Amazon 11th–20th. Source stage determines the actual action; calendar
  windows do not change Amazon deadlines. Submitted current-stage responses are excluded.
- Each recipient gets only their active Ops membership scope. Station, Cluster/AOM, SLP,
  National Head, Finance and Control Tower roles plus configured Jamsheer receive the stage
  summary if they have pending shipments. Access is rechecked before delivery. Excel has the
  same scope. Completed recovery plans awaiting approval are not missing updates.
- Each stage has one thread; recovery uses the cycle beginning on the 20th, including replies
  on the following 1st–5th. Each edition keeps an independent reservation and message ID.
- Settings → Notifications controls both editions for each stage. New controls are seeded
  disabled; enable only after deployment and production preview verification. Old daily digest
  remains disabled for the main company to prevent redundant mail.
- Recovery Master now configures exclusive per-person thresholds: >₹7,000 for 2 months,
  >₹10,000 for 3 months, +₹5,000 for each additional month. Both months and monthly-amount
  plans obey the resulting schedule length. A database trigger validates new/changed
  schedules. Existing schedules, approval transitions, recovery keys and payroll obligations
  remain unchanged. Recurring plans still require exception approval.
- Migrations: `20261028190000_loss_installment_amount_rules.sql` and
  `20261028191000_loss_stage_reminders.sql`. Apply individually and record versions.
- Validation: `pnpm run test:loss-stage-reminders`; boundary cases also live in
  `src/lib/ops-pulse/nl-loss-installments.test.mjs`.

### Proactive TID exceptions (28 October 2026)

- Exceptions replaces the separate approvals and redispute navigation. Only SLP Manager,
  Finance Manager, Managing Partner and National Head can see/manage it, with existing
  station scope and read-only checks. Master ownership alone does not confer access.
- Single or bulk TIDs can enable Redispute, Deduct next month and Recurring debit, with a
  required reason. Redispute uses the existing versioned response state machine; the other
  options use `nl_loss_exception_set` and append-only `nl_loss_exception_events`.
- Next-month grants pin the next applicable payroll month. Both types bind to source amount
  and status. Changed sources require re-enablement. The canonical recovery writer enforces
  grants atomically under its existing company lock. An enabled option does not itself debit pay.
- Enabled, otherwise eligible plans go directly to payroll. Departures, cap overrides, returned
  cases and changed sources retain independent review. Existing approved schedules remain
  valid after disabling an option; new/changed schedules require the option again.
- Recurring choices derive from each person's share and configured thresholds. The form
  explains equal monthly splits versus a fixed per-person amount, shows each deduction,
  the total and final deduction. Redispute review contains only station-submitted evidence.
- Apply `20261028220000_loss_exception_options.sql` individually with the coordinated app
  release and record the version. The HRMS due-line contract and recovery keys are unchanged.
- Validate with `pnpm run test:loss-recovery-payroll`; the lifecycle database fixture applies
  the migration twice and checks denied saves, enable/revoke, preserved payroll and audit history.

## Available-pay recovery — 28 October 2026 (supersedes percentage caps)

Recovery uses available pay after other allocated recoveries. The 50% salary cap,
override checkbox/reason, Master percentage setting and percentage-based approval
condition no longer apply to new saves. Server and database checks always verify
payable salary. Workforce and HRMS payroll fit whole due lines within remaining
take-home; a line that does not fit stays due for a later eligible payroll. No partial
line deduction, recovery-key change or rewrite of completed payroll is introduced.
Legacy override fields remain as audit metadata. Existing decisions remain recorded;
the migration does not automatically approve old pending plans.

Apply `20261028233017_loss_available_pay.sql` individually after
`20261028220000_loss_exception_options.sql` and the PID history migration. Record the
version, never run a blanket push. It is safe to apply twice and normalizes future
policy writes to available-pay validation. Due RPCs retain their shape and return 100
percent for compatibility. Release the Dashboard and companion HRMS payroll changes
together. Tests cover >50% saves, available-pay reservations, legacy client fields,
carry-forward, paid-history preservation and the existing redispute gates.

### Loss clarification retired — 29 October 2026
DropX One loss recovery is read-only for all recipient profiles. The clarification
button, question history and Ops reply inbox are removed. Legacy POST requests and
the Ops clarification endpoints return 410; lifecycle `clarify` is denied. These
routes no longer call the clarification RPCs or create payroll holds. Historical
database records remain for audit only. Existing held plans are not automatically
approved: authorised reviewers can use the normal recovery correction/approval
flow without the retired question-resolution prerequisite. Restricted shipment
redisputes and payroll deduction history remain unchanged.


### Former staff and unpaid payroll (29 October 2026)

- NL / SLP Final recipients include ended People engagements at their posting during an unpaid payroll month, plus Workforce profiles with an open payable period. EDSP/XPT scope and the AOM ceiling still apply.
- A former worker may use an unpaid earlier month while that payroll is draft/calculated (People) or unclosed (Workforce). This is independent of the loss month and the normal fifth-day default. The chosen month is explicit; multi-person allocations cannot combine different months silently.
- Paid amounts and issued/processing bank instructions are excluded. The picker reveals only the maximum recovery capacity for former People, not gross salary or salary components. Saving rechecks payroll state and balance under bank/payroll locks. Former-worker or older-month plans still require independent approval.
- An explicitly validated allocation receives `unpaid_open_payroll`, but the configured `payroll_start_month` is now a hard lower boundary (October 2026). Earlier unpaid months are excluded from directory eligibility, new saves and due payroll lines. October and later open unpaid months remain available after the normal fifth-day default moves forward. Existing recovery keys, locked deductions, source and redispute gates remain unchanged. Migration `20261029190100_loss_payroll_start_boundary.sql` supersedes the earlier rollout-month exception.
- People refresh may append new whole loss lines to a partly-paid open snapshot only within its unpaid balance. It preserves all previous items/earnings, never edits issued bank files, and verifies run/bank/due hashes atomically. Workforce calculation also respects paid and processing bank amounts.
