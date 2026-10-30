import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeStatement,
  money,
  date,
  reference,
} from "../src/statement.js";
const input = () => ({
  account: "12345678901234",
  start: "15/10/2026",
  end: "16/10/2026",
  total: 3,
  complete: true,
  rows: [
    ["1", "16/10/2026", "S100", "Charge B", "", "Dr.", "5.00", "65.00"],
    ["2", "16/10/2026", "S100", "Charge A", "", "Dr.", "30.00", "70.00"],
    [
      "3",
      "15/10/2026",
      "S090",
      "NFT/FBPT262888567027/FDRL/Supplier",
      "",
      "Cr.",
      "10.00",
      "100.00",
    ],
  ],
});
test("retains distinct debits sharing transaction ID; validates chronological balances", async () => {
  const s = await normalizeStatement(input());
  assert.equal(s.rows.length, 3);
  assert.equal(new Set(s.rows.map((r) => r.fingerprint)).size, 3);
  assert.equal(s.opening, "90.00");
  assert.equal(s.closing, "65.00");
  assert.equal(s.rows[0].reference, "FBPT262888567027");
  assert.equal(s.rows[1].reference, "");
});
test("identical captures have stable fingerprint despite different capture times", async () =>
  assert.equal(
    (await normalizeStatement(input())).sha256,
    (await normalizeStatement(input())).sha256,
  ));
test("partial pagination rejected even when surviving balances agree", async () => {
  const i = input();
  i.rows.pop();
  await assert.rejects(normalizeStatement(i), /Incomplete/);
});
test("missing intermediate rows cannot silently reduce total", async () => {
  const i = input();
  i.rows.splice(1, 1);
  i.total = 2;
  i.rows[1][0] = "2";
  await assert.rejects(normalizeStatement(i), /Running balance/);
});
test("refuses duplicate page and changed ordering", async () => {
  const i = input();
  i.rows[1][0] = "1";
  await assert.rejects(normalizeStatement(i), /sequence/);
});
test("rejects filters represented as incomplete capture", async () => {
  const i = input();
  i.complete = false;
  await assert.rejects(normalizeStatement(i), /Incomplete/);
});
test("invalid dates, direction, period, amounts fail closed", async () => {
  for (const change of [
    (i) => (i.rows[0][1] = "31/02/2026"),
    (i) => (i.rows[0][5] = "?"),
    (i) => (i.rows[0][6] = "-1"),
    (i) => (i.rows[0][6] = "1.999"),
    (i) => (i.rows[0][1] = "17/10/2026"),
  ]) {
    const i = input();
    change(i);
    await assert.rejects(normalizeStatement(i));
  }
});
test("money uses integer paise including negative balances", () => {
  assert.equal(money("1,23,456.78"), 12345678n);
  assert.equal(money("-5.01"), -501n);
  assert.throws(() => money("NaN"));
  assert.throws(() => money("1e7"));
  assert.throws(() => money(""));
});
test("does not manufacture UTR from narration or bank transaction ID", () => {
  assert.equal(reference("TO ECM/628907508283/SHOP"), "");
  assert.equal(reference("S100"), "");
  assert.equal(reference("NFT/FBPT262888567027/FDRL/A"), "FBPT262888567027");
});
test("validates calendar date rather than allowing JavaScript normalization", () => {
  assert.equal(date("29/02/2024"), "2024-02-29");
  assert.throws(() => date("29/02/2026"));
});
