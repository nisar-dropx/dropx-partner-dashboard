import test from "node:test";
import assert from "node:assert/strict";
import { excludeFinanceRecipients } from "./payment-email-recipient-policy.ts";

test("payment mail excludes every Finance portal member", () => {
  assert.deepEqual(
    excludeFinanceRecipients(
      ["koza@dropxlogistics.com", "FASNA@dropxlogistics.com", "nisar@dropxlogistics.com"],
      ["fasna@dropxlogistics.com", "NISAR@dropxlogistics.com"]
    ),
    ["koza@dropxlogistics.com"]
  );
});
