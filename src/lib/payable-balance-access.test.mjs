import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Payable balance is a read-only Payments destination on Dashboard, People and Finance", () => {
  const dashboardNavigation = read("./app-navigation.ts");
  const peopleNavigation = read("./people/navigation.ts");
  const financeNavigation = read("./finance/navigation.ts");
  const authorization = read("./authorization.ts");
  const accessPages = read("./access-pages.ts");
  const accessSurface = read("./access-surface.ts");
  const financeSurface = read("./finance/surface.ts");
  const permissionMatrix = read("../components/permission-matrix.tsx");
  const middleware = read("../middleware.ts");

  const navEntry = /code: "payable_balance", label: "Payable balance", href: "\/payments\/payable-balance"/;
  assert.match(dashboardNavigation, navEntry);
  assert.match(peopleNavigation, navEntry);
  assert.match(financeNavigation, navEntry);

  assert.match(authorization, /payments: \[[^\]]*"payable_balance"/);
  assert.match(authorization, /requiredCodes = \[[^\]]*"payable_balance"/);
  assert.match(accessPages, /code: "payable_balance", name: "Payable Balance \(view only\)"/);
  assert.match(
    accessPages,
    /seedTargetPermissionsFromSources\(supabase, companyId, \["workforce_payouts"\], "payable_balance", true\)/
  );
  assert.match(permissionMatrix, /"workforce_payouts", "payable_balance", "payment_recoveries"/);
  assert.equal((accessSurface.match(/"payable_balance"/g) ?? []).length, 2);
  assert.match(financeSurface, /"payable_balance"/);

  // This consolidated finance view is not part of the moved Ops payment surface.
  assert.doesNotMatch(middleware, /"\/payments\/payable-balance"/);
});
