# DropX One Vercel project

This folder is the standalone Vercel root for `one.dropxlogistics.com`.

Last deployment sync: 2026-07-19.

It reuses the existing Connect UI and API implementation from `../../src`, but has its own `vercel.json` without dashboard cron jobs.

Vercel setup:

1. Create a new Vercel project with root directory `apps/connect`.
2. Add the required DropX One environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Point `one.dropxlogistics.com` to this project.
4. Keep `dashboard.dropxlogistics.com` on the existing root project.

The WhatsApp OTP profile and template mapping stay in the dashboard database settings.
