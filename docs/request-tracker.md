# Dashboard Request Tracker

Route: `/request-tracker`. API: `/api/request-tracker`.

This is a read-only, company-owner Dashboard surface. Ordinary Reports grants do not enable cross-portal access. Both the server page and API enforce owner access; the API takes company identity only from the session. Confidential contact, identity, banking and file fields are recursively protected before event storage and API output. Existing source portals retain authority and permissions.

The register has exact-reference and UUID lookup, source-type and status filtering, stable pagination, an expandable timeline, explicit linked records and nested source details. Database changes and legacy workflow records have separate provenance. Missing sources are shown as unavailable. Current-stage duration is only derived from an actual matching transition in the loaded event page; unknown duration is not inferred from last update.

## Database release

Apply `supabase/migrations/20260928123000_dashboard_request_tracker.sql` from the pushed release commit before promoting Dashboard. It registers 49 source families (shared Fleet payments use the canonical payment family), creates service-readable audit tables and read-only RPCs, and attaches mutation triggers only to existing tenant-bearing root/child tables. Composite queues without verified tenant mapping remain unavailable. New domain tables added later require an adapter/trigger migration.

The audit covers subsequent changes to installed root tables and registered child tables. Earlier history depends on retained source events. Legacy audit rows may be mutable; the screen identifies their provenance. RPCs are executable only by the existing backend service role; browser roles cannot call them. Service-role users cannot edit/delete tracker audit rows. Database superusers remain outside that protection.

The actor derived from `auth.uid()` is execution attribution. A row's `updated_by`/`created_by` value is only a separately labelled hint. Shared service-role or SQL writes without human context are shown as Backend / service, never attributed to a guessed user. This release does not rewrite domain approval transactions or create a new reversal workflow; existing reversals and field corrections appear where recorded.

No automatic data backfill is performed. Existing events are read from canonical sources. Deleted roots captured after enablement remain discoverable by retained reference and UUID. Related-record results are bounded to 21 per source. Search/history offsets are bounded to 10,000; unusually large histories need a later cursor adapter rather than an unbounded request.

## Verification

- `node scripts/verify-request-tracker.mjs`: disposable PostgreSQL checks for company isolation, legacy dual approval FKs, recursive redaction, link resolution, transactional rollback, actor recording, immutable service access, deleted-root lookup and stable pagination.
- `node scripts/verify-request-tracker-api.mjs`: signed-out, non-owner and wrong-portal denial; trusted tenant selection; input validation; private cache headers; paid-state precedence.
- Normal repository prebuild and build checks remain required. Large local builds may need `NODE_OPTIONS=--max-old-space-size=8192`.

## Rollback

Promote the previous verified Dashboard deployment if the UI release fails. The additive audit schema can remain, preserving captured history. If a specific trigger causes an operational failure, disable that named trigger through an approved database migration and show that source's coverage gap; do not delete retained events or alter payment state to repair the tracker. A rollback must not roll back unrelated portal releases.
