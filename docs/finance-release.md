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
