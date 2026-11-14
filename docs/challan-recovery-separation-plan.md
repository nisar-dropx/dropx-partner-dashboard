# Plan: Separate Challan Recovery (independent of NL/SLP)

Goal: challan recoveries must **not** appear on the NL/station loss recovery screen.
Challans get their **own tables, own recovery screen, and own payroll-deduction path**,
fully independent of `nl_loss_month_cases` / `nl_loss_recoveries`.

## Why this is a large, payroll-sensitive change
The existing recovery engine is not one table — it is:
- `nl_loss_month_cases` (the case) + `nl_loss_recoveries` (split/installment allocations)
  + `nl_loss_recovery_events` + `nl_recovery_outcomes` + `nl_case_response_windows`.
- ~20 RPCs: `nl_loss_recovery_approve`, `nl_recovery_deduction_month`,
  `nl_recovery_current_payroll_month`, `nl_recovery_payables`, `nl_recovery_ledger`,
  `loss_recovery_payroll_windows`, `loss_recovery_people_with_locations`, waivers, etc.
- Server libs that compute payroll windows, subtract settled credits from
  `workforce_payout_effective_paid_allocations`, apply the 5th-day cutoff, salary holds,
  eligibility, and planned-vs-actual deduction timing.

A fully parallel challan path must re-implement the payroll-facing parts of this or it
will silently diverge from the salary math. Per AGENTS.md this is the most sensitive area
in the repo. The plan therefore **reuses the payroll-window/deduction primitives** (the
read-only RPCs that compute open months, settled credits and cutoffs) while keeping all
**challan case + assignment state in new, separate tables and a separate screen**.

## Phase 1 — Schema (new migration)
New tables, company-scoped, RLS service-role only:
- `fleet_challan_recovery_cases` — one row per approved challan:
  `company_id, challan_id (fk fleet_challans), challan_number, month, station_code,
   amount, status (open|assigned|recovering|recovered|closed), vehicle_no,
   offense_description, evidence_url, approved_by, approved_at, created_at, updated_at`.
  Unique (company_id, challan_id).
- `fleet_challan_recovery_allocations` — per-associate split/installments:
  `id, company_id, case_id (fk), person_ref, person_name, utr, split_mode (equal|custom),
   amount, salary_month, installment_no, installment_count, status (planned|posted|settled|waived),
   remarks, updated_by, updated_by_name, updated_at`.
- `fleet_challan_recovery_events` — immutable audit of every change.
Replace the current `fleet_challan_open_recovery_v1` so it writes to
`fleet_challan_recovery_cases` (NOT `nl_loss_month_cases`), keeping the challan's
`recovery_month`/`recovery_case_key` stamp pointing at the new case.

## Phase 2 — Stop the NL leak
- Remove the `nl_loss_month_cases` insert from the challan recovery RPC.
- Backfill: delete the challan rows already in `nl_loss_month_cases`
  (case_key `challan:%`, source_file `fleet-challan`) and migrate them into the new tables.
- Confirm the NL/station recovery screen no longer shows any challan.

## Phase 3 — Payroll link (reuse, don't re-derive)
- A new `fleet_challan_recovery_payable` path that, for a chosen associate + salary month,
  calls the SAME read-only primitives the NL screen uses — `loss_recovery_payroll_windows`,
  `nl_recovery_current_payroll_month`, `nl_recovery_deduction_month`, settled-credit
  subtraction from `workforce_payout_effective_paid_allocations` — so cutoff/hold/eligibility
  stay identical. Challan allocations post as their own deduction lines, tagged source
  `fleet-challan`, kept separate from NL deduction lines in the ledger.
- Planned-vs-actual timing matches the NL rule: saved = planned; confirmed debit only when
  that salary month is processed.

## Phase 4 — New screen
- New Fleet (or OpsPulse) route **"Challan Recovery"**: lists challan cases, lets an editor
  assign associate(s)/UTR with equal/custom split + installments, shows planned salary month
  and actual posted deductions, with station scope + permissions matching OpsPulse recovery.
- The challan drawer's "Open recovery" link points here, not to `/team-ops/losses/recovery-updates`.

## Phase 5 — Tests + rollout
- Verify: approve a challan → lands ONLY in the new tables, NOT in `nl_loss_month_cases`;
  NL screen shows zero challans; assign split + installments; payroll window math matches the
  NL primitives for the same person/month; revert.
- Apply migration to shared Supabase per the AGENTS.md safe process; typecheck; deploy.

## Open decision for the user
- **Where should the new screen live** — under **Fleet** (next to Challans) or under
  **OpsPulse → Team Ops → Losses** as a new sibling tab? Fleet keeps it with the challan data;
  OpsPulse keeps all recovery in one product area.
- **How faithful must the payroll path be on day one** — full parity (cutoff, holds, settled
  credits, planned/actual) vs a simpler first cut (assign + planned deduction, actual posting
  later). Full parity is the larger effort.
