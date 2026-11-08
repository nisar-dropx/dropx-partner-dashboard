# Amazon DA onboarding in Workforce

`/workforce/amazon-onboarding` is the station-scoped Amazon desk. Every signed-in user with current location access can view and operate this desk
(`ops_amazon_da`), without granting the Workforce Register. Preview/read-only
sessions cannot submit or approve actions. The station selector uses
authorized current Amazon EDSP/XPT/AMXL locations. Neither an arbitrary URL nor
an altered request body can expand scope. All requests use the shared backend
worker, never Amazon credentials in the browser.

Views: Onboarding, My associates, Offboarded, Invite, Approvals, History. Profiles expand
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

## Milestones and approval gate — 8 November 2026

Expanded profiles independently load Amazon milestone names, states and subtasks.
All / To do / Done filters and compact colour badges expose the exact source
steps. The current source timestamp is retained in a five-minute private cache;
Refresh bypasses it. Lists do not trigger milestone browsers. Missing/failed
source details show a retry state, never fabricated completed steps.

OFFBOARD and INACTIVATE now start pending_approval. One Finance Manager,
Finance Head, National Head or Managing Partner can approve/reject with remarks
inside current location access. Roles are checked in the database against active
People assignments/portal roles; a typed name never grants approval. The decision
is immutable and audited independently of the requester. Amazon membership,
status, allowed action and reason are rechecked before sending. Concurrent
reviews claim the pending row once. Approval alone is not an Amazon confirmation.

Approvals defaults to all permitted stations, pending only, with 50-row pages.
Payments > Approvals links to the same queue. Station history/profile shows
requester, decision, approver, timestamp and final Amazon outcome. Inactivation
is gated too, to prevent bypassing offboarding approval by stopping delivery
access another way. Resending an invitation keeps its existing confirmation flow.

Apply only 20261108133039_amazon_da_approval_gate.sql to the shared project.
The migration also corrects the old provider-ID regex. No real requests were
created for validation. Run test-amazon-da-approval-migration.mjs,
test-amazon-da-desk-api.cjs, verify-portal-preview.mjs and worker station-desk tests.

## Priority verification queues and filters — 9 November 2026

The BGC / IDfy tab now opens Insufficiencies, followed by Address verification
pending and All current IDs. The current-ID population combines the verified
Amazon onboarding and associate rosters; offboarded IDs stay in their own view.
Counts apply search and the selected filters, independently of the selected
priority tab. One ID can legitimately appear in both priority queues. Unknown
address checks are labelled and counted separately, never treated as verified.
My associates cards show saved address pendency, red address results and specific
information requests even when Amazon status is Active or overall BGC is Green.

Searchable multi-select filters cover status, address and overall BGC checks;
onboarding additionally exposes current stage, pending saved milestone and
progress. Invitation filters use registration status and availability; approval
and history filters use action and request status. Filters use OR within a field,
AND across fields, retain zero-match selections and derive choices after all other
filters. No options or priority totals are derived from a visible pagination page.

The filters=1 API reads complete verified station rosters into a bounded private
30-second server cache, overlays company/station/email-matched saved detail
snapshots, filters server-side and returns only 24 cards plus compact choices.
No per-associate live milestone/IDfy fetch is triggered by list filters. Current
access is checked before each cache read. Refresh bypasses the roster cache;
individual details retain the existing live refresh. Source errors fail explicitly;
no empty success/count-zero fallback is used. Saved-check timestamps and refresh
errors remain visible. Changed pagination snapshots restart the cards explicitly.
No database migration, status mutation, offboarding or payroll change is included.
