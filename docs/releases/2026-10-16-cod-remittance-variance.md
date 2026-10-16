# COD submitted-remittance variance

A submitted remittance previously became green based on timing alone, even when expected and actual cash differed. COD Status now checks every submitted remittance in the returned portal window and highlights shortages or excesses above the station tolerance. A newer clean submission cannot hide an older difference. Each record is checked separately; opposite differences do not cancel.

The user confirmed **above ₹5** as the default. Exactly ₹5 is tolerated. COD Pickup Master → Edit station → Timing, amounts & refresh settings exposes a per-station override, including zero tolerance. Comparisons use integer paise derived from expected and actual amounts. Missing/invalid amounts remain unverified. Open remittances still follow the existing pickup timing rules, since their actual deposit may legitimately be zero.

The summary card, Needs action count, column filters, priority sorting and expanded record assessments use the same amount policy. The detail table identifies Short/Excess and retains portal status, amounts and dates. A submitted status is not confirmation of bank settlement. Prepare Deposit remains a separate check with its existing policy.

## Database deployment

Apply only `supabase/migrations/20261016220000_cod_remittance_variance_tolerance.sql` before deploying the application. It adds a non-null numeric tolerance with default 5 and a nonnegative constraint. Record version 20261016220000 in the shared migration ledger after applying; do not run a blanket database push.

## Regression checks

`pnpm run test:cod-status` passes 72 tests, covering amount boundaries, shortages/excesses, historical differences, per-station overrides, missing values, stale/incomplete checks, existing pickup lifecycle, filters/sorts, permissions, master save lifecycle, and migration replay. The command now runs in prebuild to protect subsequent releases.

## Live checks to record at release

- Confirm `/cod/status` shows the new remittance amount assessment on real records.
- Confirm configured station defaults in COD Pickup Master and that underlying CMS schedules are retained.
- Verify the production domain's Vercel project, deployment ID and Git commit before closing the task.
