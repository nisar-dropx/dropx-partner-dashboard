import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Workflow } from "../src/workflow.js";
import {
  catalog,
  daybook,
  bankVoucher,
  voucherXml,
  parseXml,
  COMPANY,
} from "../src/tally.js";
const masters =
  '<ENVELOPE><LEDGER NAME="Federal9427"><PARENT>Bank Accounts</PARENT></LEDGER><LEDGER NAME="Supplier &amp; Sons"><PARENT>Sundry Creditors</PARENT><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER><LEDGER NAME="Bank charges"><PARENT>Indirect Expenses</PARENT></LEDGER></ENVELOPE>';
const snapshot = () => ({
  sha256: "a".repeat(64),
  account: "12345678909427",
  rows: [
    {
      fingerprint: "b".repeat(64),
      date: "2026-10-15",
      description: "Synthetic supplier",
      reference: "TESTUTR123",
      debit: "25.50",
      credit: "0.00",
      balance: "74.50",
    },
  ],
});
const mapping = {
  rowIndex: 0,
  bankLedger: "Federal9427",
  counterLedger: "Supplier & Sons",
  billReference: "INV-1",
};
const emptyBook =
  "<ENVELOPE><BODY><EXPORTDATA><REQUESTDATA></REQUESTDATA></EXPORTDATA></BODY></ENVELOPE>";
const evidenceInput = (xml = emptyBook) => ({
  xml,
  company: COMPANY,
  from: "2026-10-15",
  to: "2026-10-16",
  complete: true,
});
function setup() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec: (q, ...args) => db.prepare(q).all(...args) };
  const atomic = (fn) => {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  return new Workflow(sql, atomic);
}
async function approved() {
  const w = setup();
  await w.uploadCatalog({ xml: masters, company: COMPANY });
  const j = await w.draft(snapshot(), mapping, "maker");
  w.decide(
    { id: j.id, version: 1, decision: "approve", confirmed: true },
    "reviewer",
  );
  w.backup({ reference: "backup/test-20261016", confirmed: true }, "reviewer");
  const e = await w.evidence(evidenceInput(), "reviewer");
  return { w, j, e };
}
function exported(pkg, { amount, duplicate = false, master = true } = {}) {
  let voucher = pkg.xml.match(/<VOUCHER [\s\S]*?<\/VOUCHER>/)[0];
  if (master)
    voucher = voucher.replace("<DATE>", "<MASTERID>123</MASTERID><DATE>");
  if (amount) voucher = voucher.replaceAll("25.50", amount);
  return `<ENVELOPE>${voucher}${duplicate ? voucher : ""}</ENVELOPE>`;
}
test("ledger names preserve XML entities and bill-wise configuration", async () => {
  const m = await catalog(masters, COMPANY);
  assert.equal(m.ledgers[1].name, "Supplier & Sons");
  assert.equal(m.ledgers[1].billwise, true);
});

test("approved unissued vouchers can be rejected and revised, issued vouchers cannot", async () => {
  const { w, j, e } = await approved();
  const rejected = w.decide(
    { id: j.id, version: 2, decision: "reject" },
    "reviewer",
  );
  assert.equal(rejected.state, "rejected");
  const revised = await w.draft(
    snapshot(),
    { ...mapping, replaceVersion: rejected.version },
    "maker",
  );
  const ready = w.decide(
    {
      id: j.id,
      version: revised.version,
      decision: "approve",
      confirmed: true,
    },
    "reviewer",
  );
  assert.equal(ready.state, "approved");
  await w.issue({ ids: [j.id], evidenceId: e.id, confirmed: true }, "reviewer");
  assert.throws(
    () =>
      w.decide(
        { id: j.id, version: w.job(j.id).version, decision: "reject" },
        "reviewer",
      ),
    /no longer a draft/,
  );
});
test("rejects entity declarations, invalid XML, unexpected root and wrong company", async () => {
  for (const xml of [
    '<!DOCTYPE x [<!ENTITY x "boom">]><ENVELOPE>&x;</ENVELOPE>',
    "<ENVELOPE><oops></ENVELOPE>",
    "<not-tally/>",
  ])
    assert.throws(() => parseXml(xml));
  await assert.rejects(catalog(masters, "Other"));
  await assert.rejects(
    catalog(
      masters.replace(
        "<ENVELOPE>",
        "<ENVELOPE><SVCURRENTCOMPANY>Other</SVCURRENTCOMPANY>",
      ),
      COMPANY,
    ),
  );
});
test("bank payment draft signs and balances entries and emits escaped Tally XML", async () => {
  const j = await bankVoucher(
    snapshot(),
    0,
    mapping,
    await catalog(masters, COMPANY),
  );
  assert.equal(j.entries[0].amount, "-25.50");
  assert.equal(j.entries[1].amount, "25.50");
  assert.match(voucherXml([j]), /Supplier &amp; Sons/);
  assert.match(voucherXml([j]), /<BILLTYPE>Agst Ref<\/BILLTYPE>/);
  assert.ok(parseXml(voucherXml([j])));
});
test("receipt draft reverses bank signs and retains stable source identity", async () => {
  const s = snapshot();
  s.rows[0].debit = "0";
  s.rows[0].credit = "25.50";
  const m = await catalog(masters, COMPANY),
    a = await bankVoucher(s, 0, mapping, m),
    b = await bankVoucher(s, 0, mapping, m);
  assert.equal(a.type, "Receipt");
  assert.equal(a.entries[1].amount, "-25.50");
  assert.equal(a.remoteId, b.remoteId);
});
test("missing bill reference, absent ledger and non-bank ledger are rejected", async () => {
  const m = await catalog(masters, COMPANY);
  for (const patch of [
    { billReference: "" },
    { counterLedger: "missing" },
    { bankLedger: "Bank charges" },
  ])
    await assert.rejects(
      bankVoucher(snapshot(), 0, { ...mapping, ...patch }, m),
    );
});
test("posting package cannot be reused as proof that Tally imported it", async () => {
  const { w, j, e } = await approved();
  const p = await w.issue(
    { ids: [j.id], evidenceId: e.id, confirmed: true },
    "reviewer",
  );
  await assert.rejects(
    daybook(w.package(p.id).xml, evidenceInput()),
    /not proof/,
  );
});
test("one source row gets one job; revision requires exact draft version", async () => {
  const w = setup();
  await w.uploadCatalog({ xml: masters, company: COMPANY });
  const j = await w.draft(snapshot(), mapping, "maker");
  await assert.rejects(w.draft(snapshot(), mapping, "maker"), /already has/);
  const revised = await w.draft(
    snapshot(),
    {
      ...mapping,
      counterLedger: "Bank charges",
      billReference: "",
      replaceVersion: j.version,
    },
    "maker",
  );
  assert.equal(revised.id, j.id);
  assert.equal(revised.version, 2);
  assert.throws(
    () =>
      w.decide(
        { id: j.id, version: 1, decision: "approve", confirmed: true },
        "reviewer",
      ),
    /changed/,
  );
});
test("approval requires confirmation and matching master catalog", async () => {
  const w = setup();
  await w.uploadCatalog({ xml: masters, company: COMPANY });
  const j = await w.draft(snapshot(), mapping, "maker");
  assert.throws(
    () => w.decide({ id: j.id, version: 1, decision: "approve" }, "reviewer"),
    /Confirm/,
  );
  await w.uploadCatalog({
    xml: masters.replace("Bank charges", "Fees"),
    company: COMPANY,
  });
  assert.throws(
    () =>
      w.decide(
        { id: j.id, version: 1, decision: "approve", confirmed: true },
        "reviewer",
      ),
    /masters changed/,
  );
});
test("approved jobs require a recent backup and fresh period-covering Day Book", async () => {
  const { w, j, e } = await approved();
  w.set("backup", null);
  await assert.rejects(
    w.issue({ ids: [j.id], evidenceId: e.id, confirmed: true }, "reviewer"),
    /backup/,
  );
  assert.equal(w.job(j.id).state, "approved");
});
test("package issuance is atomic and never issues the same job twice", async () => {
  const { w, j, e } = await approved();
  const p = await w.issue(
    { ids: [j.id], evidenceId: e.id, confirmed: true },
    "reviewer",
  );
  assert.equal(w.job(j.id).state, "issued");
  assert.equal(w.package(p.id).jobIds.length, 1);
  await assert.rejects(
    w.issue({ ids: [j.id], evidenceId: e.id, confirmed: true }, "reviewer"),
    /unissued/,
  );
});
test("a matching existing Tally voucher prevents issuance", async () => {
  const { w, j } = await approved();
  const xml = exported({ xml: voucherXml([w.job(j.id)]) });
  const e = await w.evidence(evidenceInput(xml), "reviewer");
  await assert.rejects(
    w.issue({ ids: [j.id], evidenceId: e.id, confirmed: true }, "reviewer"),
    /already exists/,
  );
  assert.equal(w.job(j.id).state, "approved");
});
test("readback verifies identifiers, master ID, date, type and every ledger amount", async () => {
  const { w, j, e } = await approved();
  const p = await w.issue(
    { ids: [j.id], evidenceId: e.id, confirmed: true },
    "reviewer",
  );
  const readback = await w.evidence(
    evidenceInput(exported(w.package(p.id))),
    "reviewer",
  );
  const result = w.verify(
    { packageId: p.id, evidenceId: readback.id },
    "reviewer",
  );
  assert.equal(result.state, "verified");
  assert.equal(w.job(j.id).state, "verified");
  assert.equal(result.results[0].voucherNumber, `FIN-${j.id.slice(0, 16)}`);
});
test("duplicate IDs, changed amounts and missing Tally master IDs remain exceptions", async () => {
  for (const options of [
    { duplicate: true },
    { amount: "26.50" },
    { master: false },
  ]) {
    const { w, j, e } = await approved();
    const p = await w.issue(
      { ids: [j.id], evidenceId: e.id, confirmed: true },
      "reviewer",
    );
    const ev = await w.evidence(
      evidenceInput(exported(w.package(p.id), options)),
      "reviewer",
    );
    assert.equal(
      w.verify({ packageId: p.id, evidenceId: ev.id }, "reviewer").state,
      "needs_review",
    );
    assert.equal(w.job(j.id).state, "exception");
  }
});
test("payment plans validate beneficiary and exact amounts and are idempotent", async () => {
  const w = setup();
  const input = {
    valueDate: "2026-10-16",
    debitAccount: "12345678909427",
    items: [
      {
        id: "p1",
        reference: "PAY1",
        amount: "10.25",
        account: "001234567890",
        ifsc: "FDRL0001234",
        name: "Test Supplier",
      },
    ],
  };
  const a = await w.paymentPlan(input, "owner"),
    b = await w.paymentPlan(input, "owner");
  assert.equal(a.id, b.id);
  assert.equal(a.total, "10.25");
  assert.equal(w.status().paymentPlans.length, 1);
  await assert.rejects(
    w.paymentPlan(
      { ...input, items: [{ ...input.items[0], ifsc: "bad" }] },
      "owner",
    ),
  );
  assert.equal(w.plan(a.id).state, "prepared");
});
