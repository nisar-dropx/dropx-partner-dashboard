# Loss lifecycle audit — 6 November 2026

Scope: OpsPulse NL/SLP recovery, exceptions, redispute evidence/review/outcome, period closure, People refresh and Workforce payout invalidation. This is a focused code/database audit, not a claim that every production screen or every possible vulnerability has been tested.

| Gap | Repair |
| --- | --- |
| Expanded active redisputes opened a blank recovery form despite saved evidence/status | Initialize from saved redispute; load evidence/status immediately; refresh parent after save. |
| Disabled windows could hide their history from station users | Preserve read-only history within the existing company/station access scope. |
| Closed-period evidence screen could appear editable | Include the period lock in API read-only state; existing database locks remain authoritative. |
| Redispute changes and approvals did not immediately wake People payroll | Refresh after successful transitions; show pending/scheduled/synced results honestly. |
| Workforce caches could miss allocation-specific prior salary months | Invalidate original allocation months and old/new redispute recovery months. |
| Redispute outcome month validation could reject valid months | Use an unambiguous numeric YYYY-MM expression. |
| Period closure could strand active redisputes or unapproved/returned recovery plans | Reject closure until these are resolved; preserve source imports and settlement processing. |
| Recovery settings/approval lookup failures could be treated as missing data | Fail closed with actionable errors. |
| Internal trigger helpers retained client execution grants | Restrict execution to service role; fix recovery month helper search path. |
| Management ticket CTA could activate before required ticket/follow-up fields | Require the fields before enabling submit; server validation retained. |

## Validation

- Production RPRN September cases 630453518946 and 515209751948 retain enabled redispute windows; no financial records changed for this fix.
- Loss recovery/payroll regression suite, API access tests, TypeScript check and full Next.js build passed.
- Expanded-form rendering tests cover six active redispute states.
- PGlite tests apply migrations twice, validate payroll-month rules, verify period lock paths and unfinished-review closure guards.
- Grant tests preserve validation/history trigger execution while removing client RPC grants.
- Existing company/station scope, read-only role checks, optimistic versions, independent review, mandatory station evidence and payroll ceilings remain in force.

## Boundaries

No synthetic payroll/recovery mutations were performed in production. Existing manual removals are preserved. People refresh can remain pending on an external failure and reports that state instead of claiming a deduction is applied. Separate project-wide advisor findings outside Losses were not changed by this release.
