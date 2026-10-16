import test from "node:test";
import assert from "node:assert/strict";
import { collectFednet, isStatementUrl } from "../src/collectors.js";
const frame = (page, patch = {}) => ({
  headers: [
    "Sl No.",
    "Date",
    "Transaction ID",
    "Particulars",
    "Cheque Number",
    "Amount Type",
    "Amount",
    "Balance Amount",
  ],
  rows: [
    [
      String(page + 1),
      "16/10/2026",
      "S100",
      "Test",
      "",
      "Dr.",
      "10",
      String(90 - page * 10),
    ],
  ],
  account: "12345678901234",
  start: "16/10/2026",
  end: "16/10/2026",
  type: "all",
  amountFrom: "",
  amountTo: "",
  cheque: "",
  info: `Showing ${page + 1} to ${page + 1} of 2 entries`,
  previousDisabled: page === 0,
  nextDisabled: page === 1,
  ...patch,
});
function browserFixture(frames, initial = 0) {
  let position = initial,
    reads = 0;
  return {
    url: () => "https://fednet.federal.bank.in/prod/statementnew/",
    evaluate: async () => {
      reads++;
      return structuredClone(
        typeof frames === "function"
          ? frames(position, reads)
          : frames[position],
      );
    },
    click: async (selector) => {
      if (selector.endsWith("_previous")) position--;
      else if (selector.endsWith("_next")) position++;
      else position = 0;
    },
    waitForFunction: async () => {},
  };
}
test("collects all pages, returning to first page even when starting in the middle", async () => {
  const result = await collectFednet(browserFixture([frame(0), frame(1)], 1));
  assert.equal(result.complete, true);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0][0], "1");
});
test("changed account, headers and filtered capture fail closed", async () => {
  for (const patch of [
    { account: "999999999999" },
    { headers: ["changed"] },
    { info: "Showing 2 to 2 of 2 entries (filtered from 5 total entries)" },
  ])
    await assert.rejects(
      collectFednet(browserFixture([frame(0), frame(1, patch)])),
      /changed/,
    );
  await assert.rejects(
    collectFednet(browserFixture([frame(0, { amountFrom: "100" }), frame(1)])),
    /Clear/,
  );
});
test("new activity shifting the first page during collection is rejected", async () => {
  await assert.rejects(
    collectFednet(
      browserFixture((page, reads) =>
        frame(page, reads > 2 ? { rows: [["new activity"]] } : {}),
      ),
    ),
    /New bank activity/,
  );
});
test("early last page is incomplete and cannot claim a full capture", async () => {
  const result = await collectFednet(
    browserFixture([frame(0, { nextDisabled: true })]),
  );
  assert.equal(result.complete, false);
});
test("exact FedNet statement origin required", () => {
  assert.equal(
    isStatementUrl("https://fednet.federal.bank.in/prod/statementnew/"),
    true,
  );
  for (const u of [
    "http://fednet.federal.bank.in/prod/statementnew/",
    "https://fednet.federal.bank.in.attacker.example/prod/statementnew/",
    "https://fednet.federal.bank.in/login",
  ])
    assert.equal(isStatementUrl(u), false);
});
