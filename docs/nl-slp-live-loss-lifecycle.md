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

### Case controls and Initial / Final views (26 October 2026)

NL uses **Initial · pending** and **Final · recovery**. Final includes confirmed outcomes from both current and archived imports; it does not wait for the whole month to close. Active eDSP/NL review stages remain Initial even if a preliminary source label says Recoverable. A missed deadline or not-disputed status alone is not a confirmed loss. Final defaults to Recoverable; Non-recoverable and All remain accessible. The default section is Initial on India dates 1–24 and Final from the 25th. An explicit section choice overrides the calendar.

TIDs open the shared, station-scoped SCC Shipment details dialog. Source metadata and vendor history are collapsed. The directory loads without calculating every employee's salary; only selected people trigger salary calculations, with fresh server-side checks on save. Payroll caps, independent approval and deduction keys are unchanged.

Routine recovery choices exclude redispute, generic non-recoverable and DA/UTR-left shortcuts. **Person left · recovery outstanding** requires an employee ID, full name, departure remarks and recovery owner/next step. Its lifecycle is `exit_balance`, never `not_recoverable`. Prior records remain intact. Workbook imports enforce the same controls; departed-person updates use the form.

`/team-ops/losses/vendor-response?month=YYYY-MM&case=...` provides a scoped case response window. SLP and explicit roles above Cluster Manager, including Finance Manager, Business/National/Operations heads and Managing Partner, may activate or close it for one TID, with a reason. Station responses require activation. Initial disputes and replies requested by Amazon retain their source deadlines. Exceptional redisputes use the separately activated case response window. Evidence links are optional, HTTPS and explicitly confirmed publicly viewable; no attachment is required. Responses are recorded for the case team, not automatically submitted to Amazon. Activation never pauses recovery or changes the loss amount.

Migration `20261026153000_loss_recovery_case_controls.sql` adds append-only response events, a versioned response-window transition and recovery guards. Apply this file alone before deploying the matching app, and record its version in the shared migration history. `test:loss-recovery-payroll` covers role boundaries, India-time cutoff, preliminary/final outcomes, selected-person calculation, retired shortcuts, departed balance, stale updates, activation/revocation and unchanged payroll history; the migration is applied twice.

## Product lifecycle update — 26 October 2026

This section supersedes the earlier station/cluster-only proposal and Master-permission approval rules.

- **Disputes & outcomes:** NL Initial holds unconfirmed outcomes; NL Final shows confirmed decisions. SLP and at-risk source reports remain accessible under this source view.
- **Recovery:** a scoped all-month work queue. Current balances, pending/returned updates, departed-person balances and older unpaid plans remain visible. Collection month changes the due/future classification, never the original loss month, payroll key or historical amount. Losses opens here from the 25th (India time), otherwise in Initial.
- **Approvals:** SLP Manager, National Head, Finance Manager or Managing Partner only, always with existing page and station access. Broad Master access, AOM, Business Head and Cluster Manager are insufficient. A proposer cannot approve their own update. Station claims use the same four final roles; their own claims cannot be approved.
- Stations and clusters with Losses edit may propose. Every save, including receipt verification, departure details and edits to an approved plan, returns to pending final approval. Return requires a reason; resubmission requires independent approval again. A recoverable debt cannot be dismissed through Reject. Claim rejection is reserved for the four final roles deciding whether a newly raised claim is valid.
- **Collections:** actual reviewed HRMS/published Workforce deductions, draft reservations, outstanding and write-offs remain distinct. An unpaid month never completes an instalment. Three instalments mean three successfully deducted instalments; after three salary gaps the first unpaid key is still due, without doubling. A next-month full debit stays visible until actually collected. Exit balances remain outstanding.
- A full receipt requires the exact amount, receipt/payment reference and received date, then independent approval. A partial receipt cannot mark a case fully recovered. No actual financial transactions are performed by the desk.
- **Redisputes:** restricted submenu for those four roles. Activate individual TIDs; stations may respond only to activated TIDs. Record an LSC TT reference/link, status, next follow-up and vendor response; every update is version checked and appended to history. Filing or vendor-pending status requires a TT and follow-up date. A reported win pauses further uncollected recovery for source verification; it does not overwrite Amazon's imported outcome or reverse paid payroll. Closed/revoked windows reject further station responses. Drive evidence remains optional.
- Pending proposals cannot masquerade as scheduled collections. Legacy exception shortcuts remain flagged for review. Notifications remain in their existing enabled/disabled state; final-approval recipients now use the same role restriction.

Migration: `20261026203000_loss_recovery_product_lifecycle.sql`, applied individually after testing twice. Shared HRMS and Workforce due contracts and keys are unchanged. Validation includes role/API denial, no self-approval, return/resubmit, receipt validation, no-salary carry-forward, deferred full recovery, source drift, immutable history and stale TT updates.
