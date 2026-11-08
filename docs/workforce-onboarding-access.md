# Workforce onboarding access

The new OpsPulse and Dashboard workspace uses the `workforce_onboarding` page in Users & Access. Its view/add/edit grants are independent of `delivery_associates` (the existing Workforce register) and `ops_amazon_da` (the Amazon reference data).

This page requires an explicit role grant, including for master owners. Location scope, a broad Workforce grant, or master-owner status alone does not grant access. Missing or unavailable access configuration fails closed. Inactive roles do not contribute grants. Navigation, direct page loads, registration/inbox reads and invitation/retry APIs use the same gate. Existing station and designation checks still apply.

The page is available in both portals' access matrices. It is excluded from automatic Owner grants when the page catalog is reconciled; subsequent changes must be made in the access master. Cached master changes apply within 60 seconds, or immediately after the normal Users & Access save invalidates the cache.

Current limited release: Managing Partner and Finance Manager only. The live master also explicitly grants the legacy Owner role retained by the same two users for Dashboard compatibility. The role/member audit returned only Jamsheer and Nisar. No names, emails, or role IDs are used in the application gate. Do not widen memberships or grants as part of an unrelated rollout.

Validation: `node scripts/test-workforce-onboarding-access.cjs`, `node scripts/test-live-workforce-onboarding.cjs`, `node scripts/test-da-onboarding-api.cjs` and the command-attention tests. An unauthorised owner must be denied just like an unauthorised station user. Read-only preview must never allow writes.
