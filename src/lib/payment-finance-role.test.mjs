import assert from "node:assert/strict";
import test from "node:test";
import { isFinanceOrAccountsRoleCode } from "./payment-finance-role.ts";

test("finance and accounts role codes cannot be approval candidates", () => {
  for (const code of ["FIN", "FINMGR", "FINANCE_MANAGER", "ACCOUNTS", "AP_ACCOUNT"]) {
    assert.equal(isFinanceOrAccountsRoleCode(code), true, code);
  }
  for (const code of ["OPERATIONS_BH", "OPERATIONS_HLM", "CM", "OWNER", "FLEET_BH"]) {
    assert.equal(isFinanceOrAccountsRoleCode(code), false, code);
  }
});
