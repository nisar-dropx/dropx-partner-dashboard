# Amazon Now Store Audits

Source: Apollo_Audit_Readiness_Checklist (1).pdf, supplied by the user. The seed contains all 46 checks in eight sections. The document's advance-notice suggestion is intentionally not used: the requested workflow is a surprise audit.

## Configuration and behaviour

Dark Store navigation adds Store Audits and Ops Masters → Audit Master. The master supports editing, adding, deleting and reordering questions, editing/adding/deleting sections, evidence instructions, required answers, N/A policy, severity, corrective-action guidance and due hours. Auditor evidence and store closure evidence have independent conditions and minimum/maximum file counts. All imported checks use the same editor as newly added checks.

Initial defaults: physical/document checks require one attachment, knowledge checks require evidence when a gap is found, and store closure replies require one attachment. Each permits up to five files. Priority/food-safety/integrity findings default to 24 hours; other findings default to 48 hours. These are editable operating defaults, not deadlines stated by Amazon. Checklist compliance uses equal weights across applicable answered checks and is not an official Amazon score.

Each scheduled audit snapshots its checklist version. Later master edits do not rewrite earlier audits. Required proof, observations, actions, owner and future due date are checked on submission. Store replies need their configured proof and are reviewed before closure; leadership can return a reply with a reason. Audit and evidence changes use server-side authorization and database locks, with optimistic version checks for concurrent edits.

Existing audit leadership and store-response roles seed the configuration, limited to each user's current authorized locations and the configured Amazon Now model. Stores cannot read scheduled/in-progress audits, their attachments or reports. Completion releases the results and triggers a configurable email with PDF, using the existing one-thread-per-station mechanism. Missing mail configuration or delivery failure is visible and can be retried without losing the completed audit. No schedule email is sent to the store. Evidence uses the existing private ops-pulse-documents bucket; live inspection confirmed public=false, 30 MB limit and no direct client storage policies.

Deletion follows the existing named audit-deletion policy; completed inspections remain immutable. Store replies cannot edit the auditor's answers. Last-mile audit routes and storage records remain separate.

## Validation and rollout

- New lifecycle and PostgreSQL tests cover privacy, scope, evidence counts, incomplete submissions, snapshot preservation, state transitions, replies/reviews and concurrent evidence locks.
- Existing last-mile audit regression suite passes.
- Full TypeScript check passes with 8 GB heap.
- Local UI preview checked imported-question editing, evidence settings, adding questions, draft controls and store reply view; responsive view has no horizontal overflow.
- Generated PDF rendered and inspected.
- Migration: 20261015083000_dark_store_audits.sql. Re-running does not overwrite an edited master.
- Apply the pushed migration before promoting the OpsPulse build. Verify both new pages and the scoped store list after release. No test audit or email should be created in production for verification.
