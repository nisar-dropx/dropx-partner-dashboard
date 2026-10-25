# Live NL and SLP loss lifecycle

Operational and engineering runbook for the end-to-end recoverable-loss flow across the partner
dashboard (Ops Pulse / DropX One) and People/HRMS. The shared Supabase project is
`uimajyffojydenqsegjv`. Money still moves only through HRMS payroll or published Workforce payouts.

Companion guide: [`docs/team-ops-payroll-workflows.md`](./team-ops-payroll-workflows.md).

---

## 1. Audit map (what already existed)

```text
Amazon NL / Cloak live+historic ──► nl_loss_month_cases (report=nl)
Amazon SLP Initial/Final        ──► nl_loss_month_cases (report=slp, Final stamps final_seen_at)
Station claim approve           ──► nl_loss_month_cases (report=station, source_status=Approved)
                                      │
                                      ▼
                         nl_loss_recoveries (plan + allocations)
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
         nl_loss_recovery_due (hrms)          nl_loss_recovery_due (workforce)
                    │                                   │
         HRMS payroll run items               Workforce payout publications
                    │                                   │
                    └──────────► nl_recovery_ledger ◄───┘
```

| Layer | What existed | Gap vs required lifecycle |
| --- | --- | --- |
| Import | NL archive, SLP Initial/Final archive, station claim → case | No case-level workflow status beyond `source_status` / Cloak stage |
| Station dispute | Cloak live: `nl_dispute_requests` + `save_nl_dispute_request` (draft/submitted/returned/filed) | No link into recovery approval; SLP/station had no clarification window status |
| Recovery plan | `save_nl_recovery` with full/instalments, 50% cap, locks, write-off | Plan became payroll-due immediately; no Cluster propose → SLP approve gate; proposer could also “finalise” |
| Payroll | Keys `month\|case\|ref` / `…\|n`; exactly-once; missed cycle shifts; exit accelerates | Needed approval gate only (keys/cap/locks stay) |
| Permissions | `ops_losses`, `ops_loss_master`, `ops_loss_recovered`, role `OPERATIONS_SLPM`; station scope via `nlStationScope` | Station users with edit could save plans; no “cannot approve own proposal”; SLP scope not separate from master edit |
| Command Center | CPS / performance snapshots only | No recoverable-loss cards |
| Email | Portal digest outbox (`portal_enqueue_digest` / cron) | No loss-recovery action digest |
| DropX One | Payout disputes + earnings deductions; no Ops loss case panel | No loss reason/schedule/outstanding or associate clarification |

### Existing states (pre-lifecycle)

- **Case source:** Amazon NL statuses (Master recoverable list), SLP `SLP Initial` / `SLP Final`, station `Approved`.
- **Cloak dispute request:** `draft` → `submitted` → (`returned`  `filed`).
- **Station claim:** `submitted` → (`returned`  `approved`  `rejected`  `withdrawn`).
- **Ledger line:** `scheduled`  `in_progress`  `recovered`  `needs_review`  `exit_balance`  `written_off`.

### Existing transition functions

- `save_nl_dispute_request`, `save_nl_recovery`, `waive_nl_recovery_balance`
- `station_claim_submit`, `station_claim_transition`
- Due/ledger: `nl_loss_recovery_due`, `nl_recovery_ledger`, `nl_recovery_locked_lines`

Approver pattern for claims/holds: `holdApprovers` (CM → AOM fallback) + `loadActiveApprovalCovers`.

---

## 2. Final lifecycle

```text
imported
  → station_dispute_or_clarification_window
  → cluster_validation_pending
  → slp_final_confirmation_pending
  → recovery_approved_scheduled
  → recovery_in_progress
  → recovered

Exceptions (side paths):
  returned_to_station
  rejected
  not_recoverable
  on_hold
  needs_review
  exit_balance
  written_off
```

| Status | Meaning | Who acts |
| --- | --- | --- |
| `imported` | Case landed from NL/SLP/station; not yet in an action window | System |
| `station_dispute_or_clarification_window` | Station may dispute (Cloak NL) or request clarification | Station (scoped) |
| `cluster_validation_pending` | Cluster Manager validates / proposes recovery / returns / rejects | CM or AOM cover |
| `slp_final_confirmation_pending` | Proposal locked for SLP final amount + plan approval | SLP Manager (scoped) |
| `recovery_approved_scheduled` | Approved; first due line not yet in reviewed/published pay | Payroll/payout engines |
| `recovery_in_progress` | At least one line deducted (reviewed/published) | System (ledger) |
| `recovered` | Outstanding zero (all deducted or written off where allowed) | System |
| `returned_to_station` | CM/SLP sent back with mandatory note | Station |
| `rejected` | Not to be recovered (business reject) | CM/SLP |
| `not_recoverable` | Source is non-recoverable (NL win / Master) | System/import |
| `on_hold` | Explicit hold; not due | Authorised SLP/master |
| `needs_review` | Source amount/status drift, or associate clarification after allocation | Cluster → SLP |
| `exit_balance` | Person exited with outstanding (ledger) | HR write-off path |
| `written_off` | Exit balance waived via `waive_nl_recovery_balance` | Loss Recovery Master |

### Approval on the plan (`nl_loss_recoveries.approval_status`)

- `none` — no allocating plan (or non-deduct outcome only)
- `proposed` — Cluster saved allocations; **not** due in payroll
- `approved` — SLP locked plan; due engine may pick lines
- `returned` — SLP/CM returned proposal
- `needs_review` — future/unfinalised lines paused; reviewed/published history untouched

Legacy plans that already existed when the migration applied are backfilled to `approved` so in-flight payroll is not blocked.

---

## 3. Access control

### A. Station / location access

May: view own mapped station cases, evidence, status, recovery status, station action history; raise Cloak dispute / clarification with reason, category, note, evidence; see outcome.

Must not: edit imported facts or final loss amount; assign People/Workforce; create/change/cancel recovery plans; choose full/instalment; change payroll month/cap; approve/validate/lock/write off; access other stations.

Enforced by `nlStationScope` on reads and by API guards that refuse plan/approve/write-off without Cluster/SLP capability.

### B. Cluster Manager and above

- Review station disputes; validate, return or reject with mandatory note; propose people, method and schedule.
- Scoped stations only; AOM + acting-cover fallback via `holdApprovers` / covers.
- **Cannot approve own proposal** (DB rejects `approved_by = proposed_by`).

### C. SLP Manager / final approver

- Confirm final loss amount; approve or return proposal; lock plan; authorised cap override and exit write-off via existing Master permissions.
- Scope from Operations membership / location scope — **not** automatic company-wide from role code alone.
- Page permission `ops_loss_master` edit (and role `OPERATIONS_SLPM` where granted) gates final approve and restricted outcomes.

---

## 4. Recovery plan and payroll rules (unchanged guarantees)

- Full or instalments (including two-month); People `employee:` and Workforce `workforce:`; multi-person split must equal confirmed loss amount.
- 50% take-home cap; Master-only cap override with reason; exit final-settlement acceleration; write-off only for exit balance.
- Keys: `month|case|ref` (full) and `month|case|ref|n` (instalment). Exactly once across runs.
- Missed cycle shifts forward; never doubles. Locks after reviewed payroll / published payout (`nl_recovery_locked_lines`).
- Revisions before first deduction require re-approval. After deductions begin: controlled adjustment only — no historical mutation of reviewed/published lines.
- **New gate:** `nl_loss_recovery_due` returns lines only when `approval_status = 'approved'` and lifecycle is not `on_hold` / `rejected` / `not_recoverable` / `returned_to_station` (and not `needs_review` for paused future lines).

---

## 5. Command Center

Scoped recoverable-loss strip on the existing Ops Pulse Command Center (no new menu). Cards deep-link to Team Ops → Losses filters. Aggregates come from `nl_loss_recovery_command_summary` (bounded by station codes).

---

## 6. Daily automatic email

Event key: `loss_recovery_action_digest` (portal `ops`). Uses `portal_enqueue_digest` / `portal_digest_runs` for idempotent daily delivery. Empty action sets produce no mail. Owners:

| Action | Owner |
| --- | --- |
| Clarification / dispute window | Station Ops contacts for that station |
| Cluster validation | CM / AOM cover |
| SLP final confirmation | Scoped SLP / Loss Recovery Master editors |
| Due / blocked recovery | Plan updater / recovery owner |

---

## 7. DropX One Payments

No Losses menu. Inside existing People/Workforce Payments screens: loss reason, case reference, assigned amount, full/instalment, next due, completed deductions, outstanding, status, and cap/hold/final-settlement notes. Associate may acknowledge or request clarification (note + evidence). Clarification sets future/unfinalised recovery to `needs_review` and never reverses reviewed payroll or published payout.

---

## 8. Database objects (this delivery)

Migration: `supabase/migrations/20261022120000_nl_slp_loss_lifecycle.sql`  
Digest seed: `supabase/migrations/20261022121000_loss_recovery_action_digest.sql`

| Object | Role |
| --- | --- |
| `nl_loss_month_cases.lifecycle_status`, `lifecycle_version`, `lifecycle_note`, `lifecycle_updated_*` | Case workflow |
| `nl_loss_lifecycle_events` | Immutable transitions |
| `nl_loss_recoveries.approval_*` | Propose / approve gate |
| `nl_loss_clarifications` (+ events) | Station/associate clarification after allocation |
| `nl_loss_lifecycle_transition` | Versioned case transitions |
| `nl_loss_recovery_approve` | SLP final lock |
| `nl_loss_clarification_submit` / `nl_loss_clarification_resolve` | Clarification flow |
| `nl_loss_recovery_command_summary` | Command Center aggregates |
| `nl_loss_recovery_action_items` | Digest source |
| Updated `save_nl_recovery`, `nl_loss_recovery_due`, `nl_recovery_ledger` | Proposal + payroll gate |

Do **not** drop legacy tables/functions. Do **not** `supabase db push`.

---

## 9. Deployment (shared Supabase)

Apply **one file at a time** after PGlite tests pass (each migration applied twice in its test):

```text
1. supabase/migrations/20261022120000_nl_slp_loss_lifecycle.sql
2. supabase/migrations/20261022121000_loss_recovery_action_digest.sql
```

For each:

```text
supabase db query --linked -f <file>
supabase migration repair --status applied <version> --linked
```

### Required configuration after migrate

Ops enablement (samples, digest dry-run, live NL/SLP walkthrough, edge-case matrix):
[`docs/nl-slp-ops-enablement.md`](./nl-slp-ops-enablement.md).

1. **SLP / final approver:** `OPERATIONS_SLPM` (or equivalent) with `ops_loss_master` edit and station location scope. Do not grant `has_all_location_access` unless intentional.
2. **Loss Recovery Master:** cap override + write-off remain Master edit; confirm who holds it.
3. **Email:** Settings → Notifications → **Loss recovery · Daily action digest**. Seeded `disabled` / `delivery_ready=false`. Dry-run via `/api/ops-pulse/loss-recovery-digest-preview`. Enable only after recipient verification (set `delivery_ready` then state=enabled).
4. **Cron:** `/api/cron/portal-notifications` already registers `buildLossRecoveryActionDigest`.
5. **DropX One:** Payments panel + loss recoveries details modal.

### Production rollout checklist

- [x] `pnpm run test:loss-recovery-payroll` green (Dashboard) — includes digest + clarification-after-deduction
- [ ] HRMS vitest `payroll-ops-loss-recovery` still green (due shape unchanged for approved lines)
- [x] Apply migration 1 + 2 (ops confirmed)
- [ ] Leave digest **disabled** for dry-run day; preview HTML only
- [ ] Pick one NL live case → propose → different SLP approve → payroll draft key
- [ ] Pick one SLP Final case through the same gate into draft pay
- [ ] Pick one SLP Initial-only case: not allocatable / not due
- [ ] Cap block + override; two-month instalment; Workforce published payout lock
- [x] Associate clarification after first deduction covered in PGlite (ops: spot-check one live case)
- [x] Command Center scoped summary covered in PGlite
- [x] Digest empty day / no double send covered in code + unit tests (ops: keep disabled until ready)

### DropX One payslips

People payslips in Connect roll every loss into one **Loss Recovery Deduction** row
(`LOSS_DEDUCTION` + `OPS_LOSS_RECOVERY` / `ops_loss_recovery`). Salary Calculation keeps each
case/instalment as its own split line (month · TID). DropX One “Loss recoveries” has a details
modal for month, TID, category and outstanding.

### Manual-review cases

- Plans mid-instalment when lifecycle shipped (backfilled `approved`) — confirm next due month only.
- Source amount changed after proposal — `needs_review`, no silent deduction.
- Partial bank payout failures — Ops loss lines stay keyed; do not rewrite publications.
- Cloak dispute filed while cluster proposal open — keep Cloak history; lifecycle may move to `needs_review` if amount changes on re-import.

---

## 10. Tests

- PGlite: `scripts/test-nl-slp-loss-lifecycle-migration.mjs` (apply twice + access/edge cases)
- PGlite: digest migration idempotence in the same suite or companion script
- Extended: `test:loss-recovery-payroll`, Command Center loss summary unit tests, digest builder tests, DropX One loss panel tests
- Access: station scope isolation, no self-approve, API bypass denied

Run: `pnpm run test:loss-recovery-payroll` plus targeted suites listed in the handoff after implementation.

### Recovery controls and list usability (25 October 2026)

Live NL cases whose source decision matches the Recovery Master's recoverable statuses expose the same recovery editor as the final recovery view. SLP Initial remains report-only; SLP Final permits recovery plans. The editor gets station lifecycle permission from the server (cluster/AOM cover or authorised SLP); existing proposal, independent approval, salary caps and payroll locks still apply.

Recovery salary checks now calculate only the workforce IDs returned by the station recovery directory. Each selected individual's all-location pay is retained for an accurate salary cap. Loading failures show a retry instead of an indefinite loading indicator.

Cluster/AOM, station and reason filters support multiple values; final recovery periods do too. Existing single-value URLs continue to work. Selecting several stations opens their combined cases with station labels. Station totals and case lists have value/station sorting; CSV follows the case sort. Clearing the period filter selects all periods, while an initial visit still starts with the latest period.

Regression coverage: `pnpm run test:loss-recovery-payroll` includes filter/sort helpers, actual live/final loaders, authorised station isolation and station-scoped pay calculation, alongside the existing recovery/payroll lifecycle tests.
