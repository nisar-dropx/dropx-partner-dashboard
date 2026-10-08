import assert from "node:assert/strict";
import test from "node:test";
import { paymentReportCsv, summarizePaymentReport } from "./payment-report-export.ts";
import { readAllRows } from "./supabase-pagination.ts";

const row = (overrides = {}) => ({
  id: "one", request_no: "REQ-001", category: "expense", location_code: "GDRD",
  payment_head_name: "Adhoc Van", payment_head_external_id: "Van Adhoc",
  amount: null, amount_requested: 1200.50, status: "pending", approval_status: null,
  current_approver_role_names: [], current_step_order: 1, total_steps: 3,
  created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-01T10:00:00Z",
  ...overrides
});

test("totals use the supplied matching records and final workflow status", () => {
  const requests = [row(), row({ amount: 0, amount_requested: 500, status: "approved" }),
    row({ amount: 99.25, status: "approved", current_approver_role_id: "finance", current_step_order: 3 }),
    row({ amount: 50, status: "processed" }), row({ amount: 25, status: "returned" })];
  assert.deepEqual(summarizePaymentReport(requests), { total: 5, pending: 2, approved: 1, amount: 1374.75 });
  assert.deepEqual(summarizePaymentReport(requests.slice(0, 2)), { total: 2, pending: 1, approved: 1, amount: 1200.5 });
  assert.deepEqual(summarizePaymentReport([]), { total: 0, pending: 0, approved: 0, amount: 0 });
});

test("CSV exports every supplied match, including rows beyond the visible page", () => {
  const csv = paymentReportCsv(Array.from({ length: 1103 }, (_, index) => row({ request_no: `REQ-${index}` })));
  assert.ok(csv.startsWith('\uFEFF"Request","Request Type"'));
  assert.equal(csv.trimEnd().split("\r\n").length, 1104);
  assert.ok(csv.includes('"REQ-1102"'));
  assert.ok(csv.includes('"1200.5"'));
});

test("CSV preserves quotes, multiline values, identifiers, and Unicode while neutralizing formulas", () => {
  const csv = paymentReportCsv([row({ account_holder_name: 'Name, "Quoted"', remarks: "first\nsecond",
    bank_account_no: "001234567890123456", email: "=HYPERLINK(\"https://example.test\")",
    payment_head_name: "రవాణా", utr_cin: "@SUM(1)", amount: -12.5 })]);
  assert.ok(csv.includes('"Name, ""Quoted"""'));
  assert.ok(csv.includes('"first\nsecond"'));
  assert.ok(csv.includes('"001234567890123456"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""https://example.test"")"'));
  assert.ok(csv.includes('"\'@SUM(1)"'));
  assert.ok(csv.includes('"రవాణా"'));
  assert.ok(csv.includes('"-12.5"'));
});

test("server loading retrieves records beyond Supabase's default row cap", async () => {
  const records = Array.from({ length: 1103 }, (_, id) => ({ id }));
  const ranges = [];
  const result = await readAllRows({ range: async (from, to) => {
    ranges.push([from, to]);
    return { data: records.slice(from, to + 1), error: null };
  } });
  assert.deepEqual(ranges, [[0, 499], [500, 999], [1000, 1499]]);
  assert.deepEqual(result, { data: records, error: null });
});

test("server loading rejects partial results if a later page fails", async () => {
  const result = await readAllRows({ range: async (from) => from === 0
    ? { data: Array.from({ length: 500 }, (_, id) => ({ id })), error: null }
    : { data: null, error: { message: "Unable to load remaining records" } } });
  assert.equal(result.data, null);
  assert.equal(result.error.message, "Unable to load remaining records");
});
