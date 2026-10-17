# Team Ops, People and payroll workflows (October 2026)

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
`20261016161000_loss_recovery_installments.sql`; `src/lib/ops-pulse/nl-loss-policy.ts`,
`nl-recovery-payables.ts`, `nl-recovery-ledger*.ts`; `src/components/nl-loss-cases.tsx`,
`nl-recovery-ledger.tsx`; `src/app/api/ops-pulse/losses/recovery`, `.../ledger/write-off`;
`src/lib/workforce-loss-recovery.ts` (Workforce payouts); HRMS `src/lib/payroll-ops-loss-recovery.ts`.

Cases come from Amazon (NL, SLP Final) or from approved station claims (`report = 'station'`), all in
`nl_loss_month_cases`. A plan in `nl_loss_recoveries` assigns the full case amount to up to 50 people
(employees `employee:<id>` → HRMS payroll; Workforce `workforce:<id>` → Workforce payout).

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
  Workforce payout loader, so it was replaced. It held 0 claims when replaced.

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

Files: `supabase/migrations/20261016190000_payout_dispute_approval.sql`, `src/lib/payout-review-actions.ts`,
`src/components/payout-review-desk.tsx`.

```
open → (reviewer) propose resolve/reject + note → in_review → (another reviewer) approve → resolved | rejected
                                                        └─ send back + reason → open
```

- Function `workforce_dispute_step`. Each step is a `workforce_payout_dispute_events` row. The approved
  note becomes the `resolution` the associate sees in DropX One.
- The older one-step `workforce_decide_payout_dispute` still exists only for backward compatibility. The
  portal no longer calls it; remove it once nothing else does.
- The desk loads only the publications referenced by the disputes shown. Do not go back to loading the
  whole publication history.

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
- `assigned_count` is 0 in the source today, so delivery success % is deliberately not shown.

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
- **Training adoption.** Create real programmes and question banks. A ready-made starter programme could
  be added if wanted.
- **Clean-up.** Remove `workforce_decide_payout_dispute` once nothing calls it. The `workforce_station_loss_claims`
  table is no longer used by the portal.
- **Data quality.** `cps_shipment_daily.assigned_count` is always 0. Fix the import to enable a delivery
  success % in the scorecard.
