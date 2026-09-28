import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [page, allocationPage, migration] = await Promise.all([
  readFile(new URL("../src/app/payments/workforce-payouts/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/app/provider-mapping/direct-pay/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/20260928100000_workforce_payment_allocations.sql", import.meta.url), "utf8")
]);

assert.match(
  migration,
  /payment_method_id uuid not null references public\.payment_methods\(id\)/i,
  "Expected the direct allocation payment-method foreign key."
);
assert.match(
  migration,
  /constraint workforce_payment_allocations_method_company_fk[\s\S]*foreign key \(company_id, payment_method_id\)[\s\S]*references public\.payment_methods \(company_id, id\)/i,
  "Expected the tenant-safe composite payment-method foreign key."
);
assert.match(
  page,
  /payment_methods:payment_methods!workforce_payment_allocations_method_company_fk\(name\)/,
  "Direct allocations must explicitly select the tenant-safe payment-method relationship."
);
assert.doesNotMatch(
  page,
  /from\("workforce_payment_allocations"\)[\s\S]{0,500}payment_methods\(name\)/,
  "An unqualified payment-method embed is ambiguous when both direct-allocation foreign keys exist."
);

assert.match(
  allocationPage,
  /effectiveFrom:\s*current\?\.effective_from\s*\?\?\s*defaultEffectiveFrom/,
  "Existing direct allocations must show their saved effective-from date."
);
assert.doesNotMatch(
  allocationPage,
  /current\.effective_from\s*>\s*today\s*\?\s*current\.effective_from\s*:\s*today/,
  "Past direct-allocation effective dates must not be replaced with today's date."
);

console.log("Direct-payment relationship hints and effective dates verified.");
