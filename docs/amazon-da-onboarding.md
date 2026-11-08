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
