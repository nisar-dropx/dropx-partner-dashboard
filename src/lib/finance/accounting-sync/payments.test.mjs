import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as XLSX from "xlsx";
const require = createRequire(import.meta.url);
function compile(path, mocks = {}) {
  const m = { exports: {} };
  new Function(
    "require",
    "exports",
    "module",
    ts.transpileModule(fs.readFileSync(path, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText,
  )((name) => (name in mocks ? mocks[name] : require(name)), m.exports, m);
  return m.exports;
}
const money = compile("src/lib/finance360/model.ts");
const policy = compile("src/lib/payment-processing-policy.ts");
const treasury = compile("src/lib/finance/treasury/model.ts", {
  "../../finance360/model": money,
});
const payments = compile("src/lib/finance/accounting-sync/payments.ts", {
  "server-only": {},
  "@/lib/finance360/server": {},
  "@/lib/payment-processing-policy": policy,
  "@/lib/authorization": { isCompanyOwner: (a) => a.owner },
  "@/lib/finance360/model": money,
  "@/lib/finance/treasury/model": treasury,
});
const ID = "11111111-2222-3333-4444-555555555555";
const row = (patch) => ({
  id: ID,
  request_no: "PAY001",
  status: "approved",
  approval_status: "OWNER_APPROVED",
  amount: "50.00",
  amount_requested: "50.00",
  amount_approved: "50.00",
  payment_mode: "account_transfer",
  beneficiary_account_number: "001234567890",
  beneficiary_ifsc: "FDRL0001234",
  beneficiary_account_holder: "Test supplier",
  ...patch,
});
function context(rows = [row()], patch = {}) {
  const queries = [];
  const ctx = {
    companyId: "company",
    authorization: {
      owner: true,
      userId: "owner",
      hasAllLocationAccess: true,
      locationScopeIds: [],
      effectiveRoleIds: [],
      readOnly: false,
      ...patch,
    },
    db: {
      from(table) {
        const filters = [];
        queries.push({ table, filters });
        const result = {
          data:
            table === "payment_requests"
              ? rows
              : [{ id: "bank", account_no: "12345678901234" }],
        };
        const q = {
          select() {
            return q;
          },
          eq(k, v) {
            filters.push([k, v]);
            return q;
          },
          in() {
            return q;
          },
          order() {
            return q;
          },
          limit() {
            return q;
          },
          single: async () => ({ data: result.data[0] }),
          then: (resolve, reject) =>
            Promise.resolve(result).then(resolve, reject),
        };
        return q;
      },
    },
  };
  return { ctx, queries };
}
const request = { requestIds: [ID], bankId: "bank", valueDate: "2099-01-01" };
test("preparation requires current approval and excludes processing, paid and readonly requests", async () => {
  for (const r of [
    row({ status: "processing" }),
    row({ status: "processed" }),
    row({ status: "pending" }),
    row({ approval_status: "PROCESSING" }),
  ]) {
    const { ctx } = context([r]);
    await assert.rejects(
      payments.preparePaymentPlan(ctx, request),
      /no longer/,
    );
  }
  const { ctx } = context([row()], { readOnly: true });
  await assert.rejects(payments.preparePaymentPlan(ctx, request));
});
test("approval ceiling and bank details are revalidated server-side", async () => {
  for (const patch of [
    { amount: "50.01" },
    { amount: "0.00" },
    { beneficiary_ifsc: "bad" },
    { beneficiary_account_number: "123" },
  ]) {
    const { ctx } = context([row(patch)]);
    await assert.rejects(payments.preparePaymentPlan(ctx, request));
  }
});
test("caller-supplied beneficiary and amount cannot override scoped source records", async () => {
  const { ctx, queries } = context();
  const result = await payments.preparePaymentPlan(ctx, {
    ...request,
    items: [{ amount: "999", account: "999999999999" }],
  });
  assert.equal(result.items[0].amount, "50.00");
  assert.equal(result.items[0].account, "001234567890");
  assert.ok(
    queries.every((q) =>
      q.filters.some(([k, v]) => k === "company_id" && v === "company"),
    ),
  );
});
test("candidate list masks full accounts and reports invalid beneficiaries", async () => {
  const { ctx } = context([
    row(),
    row({ id: "other", beneficiary_ifsc: "bad" }),
  ]);
  const result = await payments.paymentCandidates(ctx);
  assert.equal(result.items[0].account, undefined);
  assert.equal(result.items[0].accountLast4, "7890");
  assert.equal(result.items[1].ready, false);
  assert.ok(!JSON.stringify(result).includes("001234567890"));
});
test("changed beneficiary or approval invalidates an old checklist", async () => {
  const original = context(),
    plan = await payments.preparePaymentPlan(original.ctx, request);
  await payments.validatePaymentPlan(original.ctx, plan);
  for (const patch of [
    { beneficiary_account_number: "991234567890" },
    { amount: "49.00" },
    { status: "processing" },
  ])
    await assert.rejects(
      payments.validatePaymentPlan(context([row(patch)]).ctx, plan),
      /changed/,
    );
});
test("review spreadsheet retains leading zeros and formula-like names as text", () => {
  const bytes = payments.paymentChecklist({
    id: "test",
    valueDate: "2026-10-16",
    debitAccount: "001111111111",
    total: "50.00",
    items: [
      {
        reference: "PAY1",
        name: '=HYPERLINK("https://example.invalid")',
        account: "000123456789",
        ifsc: "FDRL0001234",
        amount: "50.00",
      },
    ],
  });
  const book = XLSX.read(bytes, { type: "array" }),
    sheet = book.Sheets["Review checklist"];
  assert.equal(sheet.C7.v, "000123456789");
  assert.equal(sheet.C7.t, "s");
  assert.equal(sheet.B7.f, undefined);
  assert.equal(sheet.B7.t, "s");
});
