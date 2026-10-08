import test from "node:test";
import assert from "node:assert/strict";
import { loadStablePayoutWorksheet, MAX_PAYOUT_WORKSHEET_LOAD_ATTEMPTS } from "./stable-payout-worksheet.ts";

function versionSequence(...hashes) {
  let index = 0;
  return async () => ({ hash: hashes[index++] ?? hashes.at(-1), error: null });
}

test("a payout worksheet retries once when inputs change during its first read", async () => {
  let loads = 0;
  const result = await loadStablePayoutWorksheet({
    loadDependency: versionSequence("A", "B", "B", "B"),
    loadRows: async () => ({ rows: [{ version: ++loads }], error: null })
  });

  assert.equal(MAX_PAYOUT_WORKSHEET_LOAD_ATTEMPTS, 2);
  assert.equal(loads, 2);
  assert.deepEqual(result, { rows: [{ version: 2 }], error: null, dependencyHash: "B" });
});

test("a continuously changing worksheet stays blocked after the bounded retry", async () => {
  let loads = 0;
  const result = await loadStablePayoutWorksheet({
    loadDependency: versionSequence("A", "B", "B", "C"),
    loadRows: async () => ({ rows: [{ version: ++loads }], error: null })
  });

  assert.equal(loads, 2);
  assert.deepEqual(result.rows, [{ version: 2 }]);
  assert.equal(result.dependencyHash, null);
  assert.match(result.error, /still updating/i);
});

test("database and loader errors remain terminal instead of being retried", async () => {
  let loads = 0;
  const dependencyFailure = await loadStablePayoutWorksheet({
    loadDependency: async () => ({ hash: null, error: "Version unavailable" }),
    loadRows: async () => ({ rows: [{ version: ++loads }], error: null })
  });
  assert.equal(loads, 0);
  assert.equal(dependencyFailure.error, "Version unavailable");

  const loaderFailure = await loadStablePayoutWorksheet({
    loadDependency: versionSequence("A"),
    loadRows: async () => ({ rows: [{ version: ++loads }], error: "Unable to calculate payouts" })
  });
  assert.equal(loads, 1);
  assert.equal(loaderFailure.error, "Unable to calculate payouts");
});
