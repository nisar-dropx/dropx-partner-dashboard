import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
const require = createRequire(import.meta.url);
function compile(path, mocks = {}) {
  const m = { exports: {} };
  new Function(
    "require",
    "exports",
    "module",
    ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText,
  )((name) => (name in mocks ? mocks[name] : require(name)), m.exports, m);
  return m.exports;
}
const money = compile("src/lib/finance360/model.ts");
const model = compile("src/lib/finance/treasury/model.ts", {
  "../../finance360/model": money,
});
const bank = (patch = {}) => ({
  id: "b1",
  statement_id: "s1",
  account_code: "bank",
  bankAccount: "00123456",
  date: "2026-10-13",
  description: "Bank debit",
  reference: "UTR123",
  debit: "100.00",
  credit: "0",
  balance: "900",
  matched_line_id: null,
  ...patch,
});
const payout = (patch = {}) => ({
  key: "payroll:p1",
  source: "payroll",
  reference: "PAY1",
  amount: "100.00",
  approvedAmount: null,
  utr: "UTR123",
  status: "paid",
  paidDate: "2026-10-13",
  debitAccount: "00123456",
  ...patch,
});
const outcome = (b = {}, p = {}) =>
  model.reconcile([bank(b)], [payout(p)])[0].outcome;
test("exact settlement requires UTR, amount, account, paid status and date", () => {
  assert.equal(outcome(), "matched");
  assert.equal(outcome({ reference: " utr 123 " }), "matched");
  assert.equal(outcome({ reference: "" }), "missing_reference");
  assert.equal(outcome({ reference: "other" }), "unexplained");
  assert.equal(outcome({}, { status: "processing" }), "status_mismatch");
  assert.equal(outcome({}, { paidDate: null }), "date_mismatch");
  assert.equal(outcome({}, { debitAccount: "" }), "bank_unknown");
  assert.equal(outcome({ bankAccount: "" }), "bank_unknown");
  assert.equal(outcome({}, { debitAccount: "123456" }), "bank_mismatch");
  assert.equal(outcome({}, { paidDate: "2026-09-01" }), "date_mismatch");
});
test("excess, underpayment and approval ceiling remain exceptions with exact paise", () => {
  assert.equal(outcome({ debit: "100.01" }), "excess");
  assert.equal(outcome({ debit: "99.99" }), "short");
  assert.equal(outcome({}, { approvedAmount: "90.00" }), "excess");
  assert.equal(
    model.reconcile([bank({ debit: "100.01" })], [payout()])[0].difference,
    "0.01",
  );
  assert.equal(outcome({}, { amount: "1e2" }), "invalid");
  assert.equal(outcome({}, { amount: "0" }), "invalid");
});
test("duplicate source claims across payroll and requests cannot clear a debit", () => {
  const f = model.reconcile(
    [bank()],
    [payout(), payout({ key: "requests:r1", source: "requests" })],
  )[0];
  assert.equal(f.outcome, "duplicate");
  assert.equal(f.payout, null);
});
test("repeated debit reference cannot reuse the same payout even across statement periods", () => {
  assert.deepEqual(
    model
      .reconcile(
        [bank(), bank({ id: "b2", statement_id: "s2", date: "2026-10-14" })],
        [payout()],
      )
      .map((f) => f.outcome),
    ["duplicate", "duplicate"],
  );
});
test("incoming refunds/transfers are not matched as payout debits", () => {
  assert.equal(outcome({ debit: "0", credit: "100" }), "incoming");
});
test("different UTRs with the same amount are never matched", () => {
  assert.equal(outcome({ reference: "UTR999" }), "unexplained");
});
test("ledger identity changes when bank-account configuration changes", () => {
  assert.notEqual(
    model.bankLedgerCode("bank", "fingerprint-one"),
    model.bankLedgerCode("bank", "fingerprint-two"),
  );
});
test("statement mapping preserves account evidence and validates all balances", () => {
  const matrix = [
    ["Date", "Narration", "UTR", "Debit", "Credit", "Balance"],
    ["13/10/2026", "Vendor", "UTR123", "100.01", "", "899.99"],
    ["14/10/2026", "Refund", "UTR124", "", "50.50", "950.49"],
  ];
  const mapping = {
    date: 0,
    description: 1,
    reference: 2,
    debit: 3,
    credit: 4,
    balance: 5,
  };
  const rows = model.mappedRows(matrix, 0, mapping);
  assert.equal(rows[0].date, "2026-10-13");
  assert.equal(
    money.parseBank(rows, "1000", "950.49", "2026-10-13", "2026-10-14").length,
    2,
  );
  assert.throws(
    () => money.parseBank(rows, "1000", "950.50", "2026-10-13", "2026-10-14"),
    /closing/,
  );
  assert.throws(
    () =>
      model.mappedRows(
        [matrix[0], ["13/10/2026", "Vendor", "U", "100", "", ""]],
        0,
        mapping,
      ),
    /balance/,
  );
  assert.throws(
    () => model.mappedRows(matrix, 0, { ...mapping, reference: 1 }),
    /different/,
  );
  assert.throws(
    () =>
      money.parseBank(
        [{ ...rows[0], date: "2026-02-30" }],
        "1000",
        "899.99",
        "2026-02-01",
        "2026-03-01",
      ),
    /valid/,
  );
});
test("Excel dates and Indian dates are explicit; ambiguous text is rejected", () => {
  assert.equal(model.statementDate(46243), "2026-08-09");
  assert.equal(model.statementDate("1-4-2026"), "2026-04-01");
  assert.throws(() => model.statementDate("Oct 13 26"));
  assert.throws(() => model.statementDate(46243.5));
});
const company = "company-A";
function mockDb(tables, failTable = "") {
  const calls = [];
  return {
    calls,
    from(table) {
      let offset = 0,
        end = 999;
      const filters = {};
      const q = {
        select() {
          return q;
        },
        eq(k, v) {
          filters[k] = v;
          return q;
        },
        order() {
          return q;
        },
        limit() {
          return Promise.resolve({ data: [], error: null });
        },
        range(a, b) {
          offset = a;
          end = b;
          calls.push({ table, filters: { ...filters }, offset });
          return Promise.resolve({
            data: (tables[table] ?? [])
              .filter((r) => r.company_id === filters.company_id)
              .slice(offset, end + 1),
            error:
              table === failTable
                ? { message: "internal error with credentials" }
                : null,
          });
        },
      };
      return q;
    },
  };
}
const fixture = {
  payment_banks: [
    {
      company_id: company,
      id: "id1",
      display_name: "Federal",
      account_no: "00123456",
      is_active: true,
    },
  ],
  finance360_accounts: [],
  finance360_bank_statements: [],
  finance360_bank_rows: [],
  payment_requests: [],
  hr_payroll_bank_lines: [
    {
      company_id: company,
      id: "p1",
      amount: 100,
      reference: "PAY1",
      status: "paid",
      utr: "UTR123",
      debit_account_number: "00123456",
      value_date: "2026-10-13",
    },
    { company_id: "other", id: "foreign", amount: 999, status: "paid" },
  ],
  workforce_payout_payment_items: [],
  helper_payout_payment_items: [],
  workforce_payout_payment_batches: [],
  helper_payout_payment_batches: [],
  cps_cashbook_daily: [
    {
      company_id: company,
      id: "c1",
      expense_date: "2026-10-13",
      amount: 50,
      raw_payload: { "UPI Ref No": "UPI1" },
    },
  ],
};
const dataModule = compile("src/lib/finance/treasury/data.ts", {
  "server-only": {},
  "@/lib/finance360/server": {},
  "./model": model,
});
test("all sources are company-scoped and full account numbers never leave data boundary", async () => {
  const db = mockDb(fixture);
  const d = await dataModule.loadTreasury({ companyId: company, db });
  assert.equal(d.payouts.length, 1);
  assert.equal(d.cashbook.length, 1);
  assert.equal(d.banks[0].last4, "3456");
  assert.equal(JSON.stringify(d).includes("00123456"), false);
  assert.ok(db.calls.every((c) => c.filters.company_id === company));
});
test("source failure fails closed instead of silently reporting zero leakages", async () => {
  const db = mockDb(fixture, "hr_payroll_bank_lines");
  await assert.rejects(
    dataModule.loadTreasury({ companyId: company, db }),
    /Reconciliation is unavailable/,
  );
});
test("pagination reads beyond the first 1000 payout records", async () => {
  const db = mockDb({
    ...fixture,
    hr_payroll_bank_lines: Array.from({ length: 1001 }, (_, i) => ({
      ...fixture.hr_payroll_bank_lines[0],
      id: `p${i}`,
    })),
  });
  const d = await dataModule.loadTreasury({ companyId: company, db });
  assert.equal(d.payouts.length, 1001);
});

test("review writes are actor-scoped and cannot annotate another company transaction", async () => {
  const actionsLog = [];
  let found = false;
  const db = {
    from(table) {
      const filters = {};
      return {
        select() {
          return this;
        },
        eq(k, v) {
          filters[k] = v;
          return this;
        },
        async single() {
          actionsLog.push({ table, filters });
          return {
            data: found ? { id: "10000000-0000-0000-0000-000000000001" } : null,
            error: found ? null : { code: "not-found" },
          };
        },
        async insert(payload) {
          actionsLog.push({ table, payload });
          return { error: null };
        },
      };
    },
  };
  const a = compile("src/app/finance/treasury/actions.ts", {
    "next/cache": { revalidatePath() {} },
    "@/lib/finance360/server": {
      booksContext: async (action) => {
        assert.equal(action, "edit");
        return { companyId: company, authorization: { userId: "actor" }, db };
      },
    },
    "@/lib/finance/treasury/model": model,
  });
  const form = new FormData();
  form.set("row_id", "10000000-0000-0000-0000-000000000001");
  form.set("note", "Checked supporting evidence");
  form.set("company_id", "other");
  assert.equal((await a.recordReview(form)).ok, false);
  assert.equal(
    actionsLog.some((l) => l.payload),
    false,
  );
  found = true;
  assert.equal((await a.recordReview(form)).ok, true);
  const saved = actionsLog.find((l) => l.payload).payload;
  assert.equal(saved.company_id, company);
  assert.equal(saved.actor_id, "actor");
  assert.equal(saved.action, "treasury_review");
  assert.equal(saved.detail.note, "Checked supporting evidence");
});
test("bank enrollment takes its identity from the scoped bank master", async () => {
  let saved;
  const filters = {};
  const id = "10000000-0000-0000-0000-000000000001";
  const db = {
    from() {
      return {
        select() {
          return this;
        },
        eq(k, v) {
          filters[k] = v;
          return this;
        },
        async single() {
          return {
            data: {
              id,
              display_name: "Federal bank",
              account_no: "00123456",
              is_active: true,
            },
            error: null,
          };
        },
      };
    },
    async rpc(_name, args) {
      saved = args;
      return { error: null };
    },
  };
  const a = compile("src/app/finance/treasury/actions.ts", {
    "next/cache": { revalidatePath() {} },
    "@/lib/finance360/server": {
      booksContext: async (action) => {
        assert.equal(action, "add");
        return { companyId: company, authorization: { userId: "actor" }, db };
      },
    },
    "@/lib/finance/treasury/model": model,
  });
  assert.equal((await a.enrolBank(id)).ok, true);
  assert.equal(filters.company_id, company);
  assert.equal(saved.p_company, company);
  assert.equal(saved.p_action, "account");
  assert.equal(saved.p_data.name, "Federal bank · 3456");
  assert.equal(JSON.stringify(saved).includes("00123456"), false);
});

test("placeholder references never establish bank evidence", () => {
  for (const reference of ["N/A", "CASH", "0", "-"]) {
    assert.equal(
      outcome({ reference }, { utr: reference }),
      "missing_reference",
    );
  }
});
