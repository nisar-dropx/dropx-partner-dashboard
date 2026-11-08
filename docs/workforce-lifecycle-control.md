# Workforce lifecycle and rejoining

The OpsPulse Workforce Register now has **Lifecycle & exits** (`/work-force-register?section=lifecycle`). The register retains inactive and offboarded identities, including closed-station records. The mobile field on a new request looks up an exact existing mobile within the operator's station scope and links to Rejoin instead of creating another identity.

## Decisions

- **Registration overdue:** more than 15 days since creation, return for corrections or rejoin. Only pending/returned registrations with no submission, invitation, provider ID, pay/work history, punch or recent draft qualify for automatic offboarding. The legacy `provider_id_status = pending` default is not proof of a provider delay.
- **No deliveries:** a known mapped last delivery older than 30 days, with all 30 station-date partitions present for the current and linked stations. Newer attendance, other activity, approved leave and an existing exit case protect the profile. Unknown delivery history is never treated as zero work.
- **Exceptions:** conflicting registration evidence, provider processing, recent responses, stale/incomplete feeds, newer work and leave are held for review.
- **Manual actions:** Finance Accounts/Finance Manager/Finance Head, Managing Partner or National Head may individually inactivate, reactivate, offboard or rejoin within their existing Workforce edit/station scope. Preview mode cannot write.
- **Rejoin:** retain the same DropX ID, mobile and historical records; reopen registration for review. Reactivate is available for inactive profiles whose registration is already complete. Neither action reopens closed payment periods across the inactive interval. Review current station, partner readiness and an effective-dated pay period.

## Boundaries

These actions change the canonical **DropX** lifecycle. Amazon commands remain in the existing station-scoped Amazon onboarding desk, with its fresh profile checks, allowed reasons and confirmation history. The UI explicitly labels partner action as separate; a DropX state change never claims Amazon confirmed an exit. Automatic registration offboarding excludes any known provider association/invitation. There is no destructive delete.

Profiles can still have historical `lifecycle_status = onboarding` while registration is active. The audit does not treat that stale field as an unfinished application. Existing submitted exit cases are not bypassed. Inactivation is not final offboarding.

## Storage and automation

`workforce_lifecycle_audit(company)` scans source shipments, effective-dated mappings, attendance and registration evidence once per company. It returns one canonical row per DropX ID. `workforce_lifecycle_transition` locks that row, checks the observed timestamp and lifecycle version, rechecks automatic eligibility, applies the transition and writes immutable history atomically. An authoritative status guard prevents late legacy syncs reopening inactive/offboarded profiles. Financial history is retained; existing direct-pay cutoff logic remains in force.

`workforce_lifecycle_sweep` processes up to 30 eligible rows per enabled company under an advisory lock. `/api/cron/workforce-lifecycle` runs hourly at minute 10 and requires a configured CRON_SECRET. Company rollout is controlled by `workforce_lifecycle_automation_settings.enabled`; the migration defaults it off. Exceptions are never silently changed. Failed transitions return errors for the run, with no partial profile transition.

## Review-first rollout (8 November 2026)

Automatic execution is **paused** for the company while the Managing Partner reviews the Excel backlog. The scheduler remains implemented; do not enable the setting or run status transitions merely to validate the UI. The first batch had already changed 17 IDs to offboarded and 11 to inactive before the review-first instruction. Those immutable events are explicitly included in the review file.

The lifecycle desk now displays the actual automation setting, a compact flow explanation, closed-station exit candidates and per-person retry failures. The same canonical record drives the shared Workforce registration/status views. Scheduled automation rechecks eligibility before each transition and retains failed attempts with an hourly retry delay, so one failing person cannot indefinitely starve the queue.

ERSE, AWEZ, SBPD and JUGE were explicitly confirmed closed. They are stored as closure evidence rather than inferred from a stale feed. Exit candidates require known mapped delivery history older than 30 days, no newer work on the linked ID at any station, no recent punch, no approved leave, no duplicate mobile and no existing exit case. IDs delivering elsewhere are retained. Missing mappings remain exceptions. Financial attribution continues to use effective-dated station mappings; the cross-station scan is only a protective check, never a new payment attribution.

The biometric canonicalization trigger writes `profile_type = workforce` and clears legacy owner columns. Its owner constraint now accepts that exact shape; all prior ownership shapes and restrictions remain enforced. This resolves the two first-batch failures without changing either associate's status.

Tests additionally cover canonical biometric owners, conflicting owners, cross-station deliveries, inactive profiles with stale pending registration, disabled scheduler, closed-location eligibility and persistent failure retry/recovery.

`pnpm run test:workforce-lifecycle` runs a real PGlite migration twice and verifies response/submission protection, disabled unfinished registrations, missing feed data, recent attendance, identity-preserving rejoin, late-sync protection, stale-version rejection, API-role policy and immutable/private history. Registration policy regression tests also pass.
