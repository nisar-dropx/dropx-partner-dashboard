# Conversion rate rules

Payment Methods → Conversion Rate Rules configures an optional production rate for an exact
company, payment method, payment field, provider, operating model and station. Provider ID
mapping and its configured fixed rates are unchanged. No rules or example rates are seeded.

The initial calculation period is **one work date per provider ID at its mapped station**.
Conversion is `sum(selected numerator metrics) / sum(selected denominator metrics) * 100` from the provider
shipment rows already resolved to that mapping. Numeric input choices are discovered from the
production schema through a server-only function; method and field choices come from master data.
New numeric production inputs and payment methods need no code-side allowlist. It uses the unrounded percentage and the
highest inclusive slab minimum. The chosen rate multiplies the existing payable field units,
including any existing production minimum. Explicit workforce field-rate overrides retain priority.

Both formula sides support **Add metric** and **Remove** controls. For example,
`(total_delivery + c_return) / (delivery_assigned_count + pickup_assigned_count) * 100`.
The form shows a live formula preview. Each side must have at least one selected metric;
duplicate metrics within a side are rejected. Stored source expressions are only `+`-joined
validated numeric column keys, never executable expressions. Legacy single-key rules remain
unchanged. The loader selects every member of each sum; a missing/invalid member preserves
the fixed-rate fallback instead of treating unknown work as zero.

Conversion slabs start with one 0% base row. **Add slab row** and **Remove** support up to
20 rows, keeping stable input identities so removing a middle row preserves the other values.

No matching rule, missing/invalid conversion inputs, a zero denominator or inconsistent counts
retain the existing fixed rate. Routes with automatic kilometre fuel calculation and direct
attendance/fixed allocations retain their existing calculation. Conversion rules do not add
incentives, change mappings, submit payments or rewrite published snapshots.

Rules require an explicit start and end date. Start must be after the current IST date. Stored
rules cannot be edited/deleted or overlap for the same method, field and station. Later rates
require a new non-overlapping period. A trigger validates company ownership, provider/model/
station consistency, active production components and ordered slabs starting at 0%. Server
actions enforce payment-method permissions and location scope. The table has RLS and only
the trusted server's service role can read/insert; browser roles have no access.

Migration: `20261102064011_conversion_rate_rules.sql`. Apply only this file to the shared
project; do not blanket-push pending migrations. Deploy application code after the additive
migration. The loader tolerates only the missing-table/schema-cache errors during rollout;
other database failures block calculation rather than silently paying a different rate.

Combination support adds `20261102095731_conversion_metric_combinations.sql`, which broadens
the existing source checks and validator without updating any saved rules or mappings.

Verification:

```powershell
node --experimental-strip-types --test src/lib/conversion-rate-rules.test.mjs src/lib/conversion-rate-rules-db.test.mjs src/lib/workforce-production-threshold.test.mjs src/lib/workforce-payout-input-calculation.test.mjs src/lib/direct-workforce-pay.test.mjs
pnpm exec tsc --noEmit
```

The PGlite test applies the migration twice and verifies validation, history protection and
role permissions. No test rule should be inserted into production.
