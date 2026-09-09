# Finance deployment

Finance runs at `https://fin.dropxlogistics.com` in its own Vercel project:

- Project: `dropx-finance`
- Project ID: `prj_jGPCmnK52mKT2ejawPeKmwxgf1tL`
- Team: `team_ZUaGKibleXjm8sndcWNy8BM1`
- Source branch: `fix/finance-portal-20260909`

The source branch is intentionally separate from `main`. Do not merge or deploy
this Finance release to the main Dashboard, OpsPulse, People, Recruit or Connect
projects. The existing Dashboard restore is intentional and must be preserved.

Commit and push Finance changes first. Verify the exact pushed commit, run the
repository checks and `node --test src/lib/finance/portal.test.mjs`, and deploy
only the clean checkout linked to `dropx-finance`. Inspect the deployment's
project ID and Finance routes before assigning the Finance domain.

The Finance project has no inherited operations/HR background schedules. It
uses the existing Supabase database and existing company, role and location
permissions. Environment variables required for this restoration:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server only)
- `NEXT_PUBLIC_APP_URL=https://fin.dropxlogistics.com`

After release, verify both domains: Finance must serve the new Finance
deployment; `dashboard.dropxlogistics.com` must keep its prior deployment.

## Pricing and Business Performance

Finance navigation now exposes Master → Pricing Master and Business Performance
→ Revenue & Billing / Profit & Loss. The two report tabs preserve all filters.
These routes are Finance-host only. New permission codes are finance_pricing,
finance_revenue and finance_pnl; add/edit rights and read-only previews are checked
again in the server action. Every query is company scoped and restricted users
can access only their assigned station codes. Downloads use the same loader.

Apply `scripts/finance/pricing_business_v1.sql` once to create the append-only
pricing table, atomic revision writer and monthly aggregate reader. The new
objects deny anon/authenticated access; only the authorized server can call them.
The migration adds Finance page permissions to existing Finance memberships only.
Existing operational tables are read, never changed.

The original Amazon MG CSV is for August 2026 (user confirmed). Preserve its exact
decimals, unspecified fields, source filename and SHA-256. Generate a validated
SQL import with `scripts/finance/prepare-mg-import.mjs`; do not commit private source
files or database credentials. Re-importing an existing month/station is rejected.
Use Edit for corrections and Copy to month for a new effective month. Prior
revisions remain available, and stale concurrent edits fail atomically.

Amazon revenue is explicitly a management estimate: monthly MG prorated by
calendar days through the selected date. Eligibility, variable earnings, shortfall
recovery, IHS boundary rules, fees and tax remain unconfirmed and excluded. It is
not final billable revenue. Flipkart cards explicitly select progressive or
all-units monthly delivery slabs, with contiguous exclusive-lower/inclusive-upper
bounds and an unlimited final slab. No Flipkart rates are invented or seeded.

Reports aggregate existing cps_shipment_daily and cps_station_daily in SQL,
without row-limit truncation. The default is current month through today in
Kolkata; future reports are excluded. Costs use the existing source total once.
A station shared by multiple clients has no attributable client P&L until an
allocation basis is supplied. Missing pricing, quantities, costs and partial day
coverage are visible. Comparable P&L covers only allocations with both revenue
and cost. It excludes unrecorded expenses, overhead and taxes. Reports refresh
every 60 seconds while visible and offer filtered CSV downloads.

Validation: finance portal and business tests cover precision, date limits, slab
boundaries, nulls, coverage, shared costs, company/location access, write rights,
preview denial, atomic-batch inputs, export filters and navigation isolation.
