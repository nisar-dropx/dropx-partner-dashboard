# TCC3 War Room Report Bot — pilot implementation plan

**Status:** Phase 1 audit complete; build follows this plan.  
**Pilot group only:** WhatsApp group named `Testing`. Do **not** enable, message, schedule, or change `TCC3 · Adayar` during development.  
**Source of truth:** `workers/whatsapp-report-bot/` in this repository. Publish with `pnpm sync:report-bot-worker` after tests + commit. Never edit Report-bot-worker except deploy-only files listed in its `AGENTS.md`.

---

## 1. Current state (audit summary)

| Area | Today |
|---|---|
| Worker | Forwards **images / image-documents** only from enabled `@g.us` groups. Text/voice/video/stickers ignored for events. Chat view is in-memory only. |
| Company mode | `off` / `listen` / `live` on `report_bot_settings` |
| Groups | `is_enabled` + station link; **no per-group mode** |
| Report types | Free-form `name` / `description` / `rules[]`; no TCC3 catalog |
| Schedules | Per `(group, report_type)` with reminder slots, templates, `stop_when_received` |
| Submissions | Image rows → AI vision → verdict → `awaiting_approval` / auto / ignore |
| Outbox | Reminders + feedback; worker `/send` only when company mode is `live` |
| Privacy | Private chats never read; disabled groups forgotten in worker chat log |

**Event payload today (images):** `type, group_id, group_name, message_id, sender_jid, sender_name, from_me, sent_by_bot, timestamp, kind, caption, media{ref,mime,size}, message_record`. Quoted message id is **not** on the event (only in chat view).

**Do not overwrite:** `20261016180000_report_bot_reminder_slots.sql`, `20261017100000_report_bot_template_line_endings.sql`, `20261017110000_report_bot_schedule_always_remind.sql`.

---

## 2. Target behaviour for the pilot

1. **Per-group mode:** `observe` → `review` → `live` (default `observe` for new groups).
2. **Company mode** remains the master switch for the worker process (`off` stops ingest config; `listen` analyses never sends; `live` allows sends).
3. **Send gate:** WhatsApp send only when `company.mode = live` **and** the target group’s mode is not `observe`. Auto-send only when group mode is `live` and company approval rules allow it. High-risk categories never auto-send.
4. **Text + image events** from enabled groups; never voice/video/stickers/contacts/location/DMs.
5. **Correlation** of same sender/group within a configurable window (default 10 minutes).
6. **Review statuses:** `observe_only` | `draft_ready` | `approved` | `sent` | `dismissed` (alongside existing submission statuses).
7. **Open actions** board with closure evidence.
8. **Daily site summary** rollup per group/date.
9. **Duplicate configuration** is an explicit portal action (never auto-copy to TCC3).
10. Schedules for TCC3 templates are seeded **inactive (draft)** until a manager enables them.

### Mode matrix

| Company | Group | Analyse | Draft feedback | Manual send / test reminder | Auto-send |
|---|---|---|---|---|---|
| off | * | no | no | no | no |
| listen | any | yes | observe→no draft; review→draft | no | no |
| live | observe | yes | no (observe_only) | no | no |
| live | review | yes | yes | yes (approval required) | no |
| live | live | yes | yes | yes | yes (non high-risk, confidence OK) |

---

## 3. Implementation slices

### Phase 2 — Worker contract

- Add `normalizeOperationalEvent()` in `lib.mjs`: text (`conversation` / `extendedTextMessage`) and images/image-docs; extract quoted stanza id; never voice/video/sticker/contact/location.
- `forwardMessage`: push text events (no media download); keep image path; include `quoted_message_id`, `quoted_participant`, `message_type`.
- Preserve reconnect, auth, enabled-group filter, `/send` protections.
- Unit tests: text normalisation, captions, quotes, enabled-group filter, disabled exclusion, privacy.

### Phase 3 — Schema + processing

**New migration** `20261021150000_report_bot_tcc3_pilot.sql` (idempotent, PGlite double-apply tested):

- `report_bot_groups.mode` (`observe`|`review`|`live`, default `observe`)
- Settings: `correlation_window_minutes`, `inbound_retention_days`
- `report_bot_inbound_events` — operational messages (text/image metadata), retention prune key
- `report_bot_review_items` — classification + review_status + AI JSON + link to events/submissions
- `report_bot_actions` — open action tracking
- `report_bot_review_audit` — approve/edit/send/dismiss history
- `report_bot_daily_summaries` — per group × business date rollup
- Schedule extras: `review_only`, `escalation_delay_minutes`, `schedule_kind` (`timed`|`interval`|`event_driven`)
- Report type extras: `slug`, `category`, `auto_reply_policy` (`never`|`normal`), `subtypes text[]`
- Claim/prune helpers as needed; RLS service_role only

**Processing:** ingest text → inbound_events → correlate → AI (text / image+caption / bundle) → review_item + optional actions. Prompt injection: treat all chat text as untrusted data (existing rule kept and extended).

### Phase 4 — Report types (portal config, not worker hardcode)

Portal action **“Install TCC3 War Room templates”** creates/updates company report types by `slug` (10 types + rules/subtypes/feedback hints). Schedules created only via **“Seed draft schedules for group”** for a chosen group (Testing), all `is_active = false`.

### Phase 5 — Correlation + AI

- Bundle events by `(group_id, sender_jid)` within `correlation_window_minutes`.
- Extend AI for text-only and multi-evidence; structured JSON only; verdicts unchanged.
- Force `needs_approval` / never auto for `auto_reply_policy = never` and high-risk categories.

### Phase 6 — Schedules

- Keep reminder slots + `stop_when_received`.
- Add schedule preview (next slots) and keep **Send test reminder** (gated: company live + group not observe).
- Draft seeds for Testing only via explicit action.

### Phase 7 — Ops Pulse UI

- Group mode control; privacy banner (“approved operational-group assistant”).
- Tabs/sections: Review Queue (review_items), Open Actions, Daily Summary, Reports & schedules (preview + duplicate config).
- Station scope / `canSeeGroup` unchanged.

### Phase 8 — Retention & safety

- Cron prune inbound events older than retention (metadata; images still not stored permanently).
- Audit every approve/send/dismiss.
- No silent rule learning from raw history.

---

## 4. Safe migration application (shared Supabase)

Apply **one file at a time**; never blanket `supabase db push`:

```bash
supabase db query --linked -f supabase/migrations/20261021150000_report_bot_tcc3_pilot.sql
supabase migration repair --status applied 20261021150000 --linked
```

Confirm version `20261021150000` is unused in People/HRMS before applying.

---

## 5. Pilot checklist (Testing only)

1. Enable only group **`Testing`**; leave `TCC3 · Adayar` disabled / untouched.
2. Set Testing mode → **Observe**; company mode → **listen** (or live only when ready to test sends).
3. Install TCC3 report type templates; seed **inactive** draft schedules for Testing.
4. Send test messages in Testing (load receipt ± evidence, shortage, handover, hourly PPI/O2A, FEFO, temperature/power, ticket closure, irrelevant).
5. Confirm Review Queue classification; **no WhatsApp reply** without approval; Observe shows `observe_only`.
6. Switch Testing → **Review**; approve/edit/dismiss; test reminder; close an action — all in Testing only.
7. Do **not** switch Testing to Live until an authorised reviewer requests it.
8. Later: explicit **Duplicate configuration** from Testing → `TCC3 · Adayar`, then Observe → Review → limited Live on TCC3.

---

## 6. Business choices still required before automated replies

- Exact reminder times per shift for TCC3.
- Which report types may ever auto-reply (none of: cold-chain, power/DG/UPS, attendance/discipline, customer complaints).
- Retention days and correlation window.
- Who may approve Live mode and duplicate config to production groups.
- Whether site summary is portal-only or also posted to WhatsApp (default: portal-only until Live + explicit enable).

---

## 7. Publish path

1. Edit + `npm test` in `workers/whatsapp-report-bot/`.
2. `pnpm run test:report-bot` in dashboard root.
3. Commit in dashboard repo.
4. `pnpm sync:report-bot-worker -- --dry-run` then `pnpm sync:report-bot-worker`.
5. Apply migration on shared Supabase (single file).
6. Verify on Testing group only.

---

## 8. Implementation deliverable (2026-10-21)

### Changed files (dashboard repo)

| Area | Paths |
|---|---|
| Plan | `docs/report-bot-tcc3-pilot.md` |
| Migration | `supabase/migrations/20261021150000_report_bot_tcc3_pilot.sql` |
| Worker | `workers/whatsapp-report-bot/lib.mjs`, `server.mjs`, `lib.test.mjs`, `README.md` |
| Portal lib | `src/lib/report-bot/logic.ts`, `ai.ts`, `settings.ts`, `pipeline.ts`, `events.ts` (new), `tcc3-templates.ts` (new), `*.test.mjs` |
| API | `src/app/api/report-bot/worker/events/route.ts` |
| UI / actions | `src/app/ops-pulse/report-bot/page.tsx`, `actions.ts` |

### Migration apply order

Only the new file (after existing report_bot migrations already applied):

```bash
supabase db query --linked -f supabase/migrations/20261021150000_report_bot_tcc3_pilot.sql
supabase migration repair --status applied 20261021150000 --linked
```

### Tests run

- Worker: `npm test` in `workers/whatsapp-report-bot/` → **16 pass**
- Portal: `pnpm run test:report-bot` → **20 pass** (includes double-apply of TCC3 migration)

### Steps to add the bot to TCC3 · Adayar (later, not now)

1. Finish Testing pilot in Observe → Review; keep TCC3 disabled.
2. Authorised reviewer: enable TCC3 group on Groups tab (starts in **Observe**).
3. **Duplicate configuration** from Testing → TCC3 · Adayar (schedules copy as inactive; target forced Observe).
4. Confirm reminder times; enable schedules one by one.
5. Observe for a few days → Review for approved drafts → limited Live only for non high-risk types.

### Recommended pilot configuration

| Stage | Company mode | Testing group mode | Sends |
|---|---|---|---|
| 1 | listen | observe | none |
| 2 | live | review | manual approve / test reminder only |
| 3 | live | live | auto only for `auto_reply_policy=normal` + confidence; never cold-chain / infra / workforce |

### Business choices still required before automated replies

- Exact shift reminder times for TCC3.
- Which report types may ever auto-reply (cold-chain, power/DG/UPS, attendance, complaints must stay `never`).
- Retention days and correlation window (defaults 30 days / 10 minutes).
- Who may approve Live and Duplicate onto production groups.
- Whether daily site summary is portal-only (current default) or WhatsApp-posted.
