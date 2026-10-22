# NL/SLP loss lifecycle — ops enablement (post-migrate)

Migrations `20261022120000` and `20261022121000` are applied. This page is the configuration and
controlled go-live checklist. Engineering reference remains
[`nl-slp-live-loss-lifecycle.md`](./nl-slp-live-loss-lifecycle.md).

---

## 1. Configuration (do in this order)

| # | Item | Expected state after migrate | Owner action |
| --- | --- | --- | --- |
| 1 | Digest control `loss_recovery_action_digest` | `state=disabled`, `delivery_ready=false`, IST `09:00`, subject with `{{date}}` | Leave disabled for dry-run day |
| 2 | Cron `/api/cron/portal-notifications` | Builder registered | Confirm host still hits cron with `CRON_SECRET` |
| 3 | Settings → Notifications → **Loss recovery · Daily action digest** | Form visible when control row exists | Use **Dry-run HTML preview** only until verified |
| 4 | SLP / Master scope | `ops_loss_master` edit + station location scope (not blanket all-locations unless intentional) | People / Access |
| 5 | Cap override + write-off | Loss Recovery Master edit | Confirm named holders |
| 6 | DropX One | Payments panel + loss recoveries modal | Deployed with dashboard |

### Enable digest only after verification

1. Dry-run day: control stays **disabled**; open  
   `/api/ops-pulse/loss-recovery-digest-preview` as a notification editor.  
   Empty day ⇒ HTML says no open actions (no mail would send).
2. Confirm recipient list matches station CM / scoped Operations emails (`@dropxlogistics.com`).
3. Mark ready in SQL (once):

```sql
update portal_notification_controls
set config = config || '{"delivery_ready": true}'::jsonb,
    updated_at = now()
where portal = 'ops' and event_key = 'loss_recovery_action_digest';
```

4. Settings → Notifications → set state **Enabled**, save. Enabling is blocked until `delivery_ready` is true.

Idempotency: `portal_digest_runs` stores one row per company/event/report_date; a second cron the same day skips.

---

## 2. Daily digest — sample template and result

### Control (seeded)

| Field | Value |
| --- | --- |
| Subject template | `DropX · Loss recovery actions · {{date}}` |
| Body template | `Unresolved NL/SLP loss recovery actions for your stations.` |
| Schedule | `09:00` Asia/Kolkata · window 90 minutes |
| `first_report_date` | `2026-10-22` |
| `email_domain` | `dropxlogistics.com` |

### Sample result (when actions exist)

**Subject:** `DropX · Loss recovery actions · 2026-10-22`

**Plain text (excerpt):**

```text
DropX loss recovery actions · 2026-10-22

Hello Cluster Manager,
2 open actions.

BLR1 | TID123456789 | ₹1,250.50 | Cluster validation | age 3d | due — | — | https://ops.dropxlogistics.com/team-ops/losses/nl?month=2026-09&case=TID123456789
BLR1 | slp:AMZ987 | ₹800.00 | SLP final confirmation | age 1d | due 2026-10 | Awaiting SLP | https://ops.dropxlogistics.com/team-ops/losses/slp-final?month=2026-09&case=slp%3AAMZ987

Open Losses: https://ops.dropxlogistics.com/team-ops/losses/nl
```

**HTML:** dark Ops Pulse header “Loss recovery actions”, table columns Station / Case / Amount / Action / Age / Due / Blocker, orange **Open Losses →** button. Empty action set ⇒ **zero messages** (no enqueue).

---

## 3. Controlled live runs (one NL + one SLP)

Use low-value real cases on a single station. Do not enable digest until both runs succeed.

### A. NL live case → payroll draft

| Step | Who | Expected |
| --- | --- | --- |
| 1 | Import/live NL | Case in `station_dispute_or_clarification_window` or `cluster_validation_pending` |
| 2 | Station (optional) | Cloak dispute or clarification; case stays station-scoped |
| 3 | Cluster Manager | Propose recovery (people + full/instalments) → `approval_status=proposed`, **not** in `nl_loss_recovery_due` |
| 4 | Different SLP user | Approve → `recovery_approved_scheduled` / `approved` |
| 5 | People payroll draft | `OPS_LOSS_RECOVERY` line with key `month\|case\|employee:<id>` (or `…\|n`) |
| 6 | DropX One | Loss recoveries panel shows month, TID, outstanding; payslip merges as Loss Recovery Deduction |

### B. SLP Final case → payout or payroll draft

| Step | Who | Expected |
| --- | --- | --- |
| 1 | SLP Final import | `final_seen_at` set; allocatable |
| 2 | Cluster propose → SLP approve (different users) | Same gate as NL |
| 3 | Workforce or People draft | Due line appears once for approved plan |

### C. SLP Initial-only (negative control)

| Step | Expected |
| --- | --- |
| Open Initial-only case | Lifecycle `imported`; `save_nl_recovery` refused (“still in SLP Initial”) |
| Forced legacy plan with Initial status | **Not** returned by `nl_loss_recovery_due` |

---

## 4. Edge-case matrix (code vs ops)

| Case | Status | Evidence / where |
| --- | --- | --- |
| SLP Initial-only not recoverable / not due | **Done** | Migration + `test-loss-recovery-payroll` / lifecycle suite |
| Cluster proposer cannot approve same recovery | **Done** | DB `nl_loss_recovery_approve` + lifecycle test |
| Two-month instalments, 50% cap, authorised override | **Done** | Installments migration suite + policy |
| Associate clarification after first deduction: past reviewed stays; future `needs_review` | **Done** | Clarification RPC + lifecycle test (payroll key unchanged) |
| Source amount change after approval: no silent/dupe deduction | **Done** | Case trigger → `needs_review`; due excludes until re-approve |
| Exit outstanding → final settlement; write-off only when authorised | **Done** | Installments suite (`final_settlement`, `waive_nl_recovery_balance`) |
| Workforce partial bank failure: keyed, not rewritten | **Done** (design) | `recovery_key` on publication items; do not rewrite publications in ops |
| Mid-instalment legacy after migrate | **Done** | Backfill `approval_status=approved`; next due continues |
| Digest empty day / no double send | **Done** | Builder returns `[]`; `portal_digest_runs` + disabled seed; unit tests |
| Command Center totals match scoped stations | **Done** | `nl_loss_recovery_command_summary(p_stations)`; empty for other station in test |
| Digest UI + dry-run preview | **Done** (this enablement) | Settings form + `/api/ops-pulse/loss-recovery-digest-preview` |
| Live NL + SLP Final walkthrough in production | **Done** (2026-10-22) | AOM Sujan propose → SLPM Varun approve; NL `630199769121` ₹0.56; SLP Final `…368262515886` ₹132 two-month + cap override; both due in 2026-10 workforce window; scripts under `scripts/operations/20261022-nl-slp-*` |
| Mark `delivery_ready` + enable digest | **Done** (2026-10-22) | Control `enabled` / `delivery_ready=true` for all companies; IST 09:00; dry-run recipients `@dropxlogistics.com` only |

---

## 5. Quick SQL checks (shared project)

```sql
-- Digest still dry-run
select state, config->>'delivery_ready' ready, config->>'schedule_time' t
from portal_notification_controls
where event_key = 'loss_recovery_action_digest';

-- Open actions that would mail (when enabled)
select station_code, case_key, action_label, age_days
from nl_loss_recovery_action_items('<company_uuid>');

-- Scoped Command Center slice
select nl_loss_recovery_command_summary('<company_uuid>', array['BLR1'], '2026-10');
```
