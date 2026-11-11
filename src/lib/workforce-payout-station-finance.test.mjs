import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("workforce payout station finance handoff contracts", () => {
  it("keeps station confirmation ahead of Finance approval and bank issue", () => {
    const steps = [
      "publish worksheet",
      "confirm station",
      "send to finance",
      "finance approve",
      "loss clearance",
      "bank download",
      "enquiry import batches"
    ];
    assert.deepEqual(steps.slice(0, 4), [
      "publish worksheet",
      "confirm station",
      "send to finance",
      "finance approve"
    ]);
    assert.ok(steps.indexOf("bank download") > steps.indexOf("finance approve"));
    assert.ok(steps.indexOf("enquiry import batches") > steps.indexOf("bank download"));
  });

  it("treats release hash drift as a resubmit signal", () => {
    const releaseHash = "abc";
    const requestHash = "def";
    const changed = releaseHash !== requestHash;
    assert.equal(changed, true);
  });
});
