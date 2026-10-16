# DropX Partner Dashboard

Deployment sync: dashboard Git connection enabled on 2026-07-19.

Next.js dashboard for Provider ID mapping, rate cards, report imports, earnings, exceptions, and salary controls.

## Current Status

This frontend is scaffolded with mock data and is ready to connect to the Supabase schema that has already been applied to the `DropX Partner` project.

## Local Setup

```bash
npm install
npm run dev
```

Create `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://uimajyffojydenqsegjv.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_APP_URL=https://dashboard.dropxlogistics.com
CASH_RECON_WORKER_URL=https://cash-recon-worker.withered-voice-1c40.workers.dev
CASH_RECON_ADMIN_KEY=
REPORT_AUTO_WORKER_URL=https://report-auto-worker.withered-voice-1c40.workers.dev
REPORT_AUTO_ADMIN_KEY=
# Set to false to hide the Auto upload button until the worker is deployed
# REPORT_AUTO_UI_ENABLED=true
```

Never expose `SUPABASE_SERVICE_ROLE_KEY` to browser or mobile code.

## Report Auto upload

On **Report Imports**, each worker-backed source has **Upload file** (manual) and **Auto upload**.

Auto calls `POST /api/report-imports/auto-run`, which proxies `REPORT_AUTO_WORKER_URL` with `x-admin-key`. Sources: `amazon_shipments`, `daily_edsp_metrics`, `delivered_shipment_detail`, `iocl_fuel`, `bpcl_fuel`, `cashbook`.

Workforce Auto first checks `formattedCreationDate` on Amazon’s weekly-supp catalog. If Amazon has not published today’s files (often 8am–12pm IST), the API returns 409 — use Manual upload.

Morning automation lives on the worker (06:00 IST kickoff + 08:00–15:00 IST poll). Set `REPORT_UPLOAD_ENABLED=true` and `DASHBOARD_IMPORT_COOKIE` on the worker so files land in Import Master. Hide the button with `REPORT_AUTO_UI_ENABLED=false` until that worker is deployed.

OpsPulse Network Planning setup and operating notes are in `docs/ops-network-planning.md`.

For independently assignable Ops menu permissions, run `scripts/ops_menu_permissions_v1.sql` before deploying the matching application release. The migration preserves current Performance, Capacity, Reports, Performance Master, and Capacity Master grants while separating their future access controls.

## Invitation Email Sender

User invitations are sent by Supabase Auth when `Send email invitation` is checked while creating a user. To send from `notification@dropxlogistics.com`, configure custom SMTP in Supabase Auth with:

- Sender email: `notification@dropxlogistics.com`
- Sender name: `DropX`
- SMTP host, port, username, and password from the DropX email provider
- Verified DNS records for SPF, DKIM, and DMARC

Keep the Supabase redirect allowlist including `https://dashboard.dropxlogistics.com/login` and `https://dashboard.dropxlogistics.com/auth/callback`.

## Vercel Setup

1. Push this folder to a GitHub repository.
2. Import the repository in Vercel.
3. Set the environment variables above in Vercel project settings.
4. Deploy.

## MVP Screens

- Dashboard
- Delivery Associate register
- Provider ID mapping
- Rate cards
- Report upload
- Earnings
- Exception queue
- Settings

## Next Build Steps

1. Replace mock data with Supabase reads.
2. Add auth and role redirects.
3. Add station-level access filters for managers.
4. Build Provider ID mapping create/correct workflow.
5. Build Amazon report import using the sample `111.xlsx`.
6. Add daily earnings calculation API route.

## Loss recovery salary deductions

Losses assigned in Team Ops → Losses are deducted from salary: People employees in HRMS payroll
(`OPS_LOSS_RECOVERY` line), Workforce members in the monthly Workforce payout (`LOSS_RECOVERY` line).
The rule lives in `supabase/migrations/20261015130000_loss_recovery_payroll_deductions.sql`
(dashboard repo, shared database).

- **Salary month.** A loss is settled on the day it is assigned (for SLP, the later of that and the
  day the case first appears in SLP Final). Settled before the 7th → the previous month's salary;
  on or after the 7th → that month's salary. "Deduct next month" adds one month.
- **NL loss for month M is never deducted earlier than month M+1's salary.** A September NL loss
  assigned on 4 Nov comes off October salary; assigned on 8 Nov, it comes off November.
- **SLP Initial is a report only.** Employees can be assigned only once the case is in SLP Final.
- **Exactly once.** A loss already on another HRMS run or another published payout is skipped; a
  month that cannot carry it (person not in that payroll, or take-home too low) moves it whole to
  the next month. A loss is never part-recovered.
- **Locked once paid.** A loss on a reviewed/approved HRMS run or a published payout cannot be
  changed or removed in Losses.
- **Manual loss deductions are separate.** HR's Salary detail "Loss deduction" upload stays a
  manual entry. Ops recoveries export in their own "Ops loss recovery" column, which the upload
  never reads back, so a re-upload cannot deduct an Ops loss twice. Do not also upload an Ops
  loss manually.
- First salary month carrying Ops losses: October 2026 (`payroll_start_month` in the recovery policy).
