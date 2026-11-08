# Amazon DA onboarding in Operations

`/workforce/amazon-onboarding` is the station-scoped Amazon desk. It inherits
Workforce Register (`delivery_associates`) access; status actions require edit
access and are disabled in preview/read-only mode. The station selector uses
authorized current Amazon EDSP/XPT/AMXL locations. Neither an arbitrary URL nor
an altered request body can expand scope. All requests use the shared backend
worker, never Amazon credentials in the browser.

Views: Onboarding, My associates, Offboarded, Invite, History. Profiles expand
in-place with Amazon status, task/next step, contact and qualifications. The
existing registered-workforce invitation action retains registration, duplicate
mapping, partner ID and station-configuration guards. New registration remains
in the existing guided Workforce/DropX One flow. No station-transfer action is
available. Amazon offboarding does not silently change DropX employment/payroll.

Lists load 24 verified associates at a time. Search and status filters run across
the source roster, not only the visible cards. Source JSON is kept in a private
worker cache for at most two minutes; initial verified pages for 30 seconds.
Current station authorization is checked before a cache hit. Refresh bypasses
both caches. Pagination restarts explicitly if its source snapshot expires.
The displayed update time is the source time. Status mutations never use cached
station membership or operational status. Browser memory keeps at most eight
views for 25 seconds and is cleared on actions/refresh.

Photos lazy-load from approved Amazon image hosts or through a protected proxy.
The latter requires current OpsPulse station access and a signed, five-minute
grant bound to company/station/profile/transporter. Amazon cookies stay inside
the worker and are never forwarded on image-host redirects. Images are bounded
to 1 MB, raster MIME types only, and retained only in the user's private browser
cache for five minutes. No image blobs or new rows are stored in Supabase.

Offboarding, inactivity and invitation resend are explicitly confirmed. The server
captures user ID, name, designation/role, station, exact Amazon profile ID, reason,
remarks and expected status before contacting Amazon. The actor/name cannot be
supplied by the browser. History expands to timestamped request/result events.
Unconfirmed outcomes stay locked; Check Amazon result verifies without repeating
the mutation. Historic direct-Amazon changes cannot identify the original user.

Release: apply `20261108101331_amazon_da_desk_audit.sql` then
`20261108104050_amazon_da_audit_privileges.sql` individually to the shared project;
deploy the matching `DROPX-LOGISTICS/workforce-worker` station-desk implementation;
then release this app. Do not blanket-push migrations. The tables have RLS and no
anon/authenticated grants. Existing profile/mapping/payroll data is untouched.

Tests: `node scripts/test-amazon-da-desk-migration.mjs`,
`node scripts/test-amazon-da-desk-api.cjs`, TypeScript and production build.
Worker tests cover scoped lists, status checks, atomic claim, timeout and safe
reconciliation. Live verification must use read-only flows; do not create an
invitation, offboard an associate or change live payroll as a test.
