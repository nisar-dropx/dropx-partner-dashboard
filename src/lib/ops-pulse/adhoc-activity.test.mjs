import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);

function compile(path, mocks = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  new Function("require", "exports", "module", code)(
    (name) => name in mocks ? mocks[name] : require(name),
    module.exports,
    module
  );
  return module.exports;
}

function queryDb(rows) {
  const calls = [];
  return {
    calls,
    db: {
      from(table) {
        const operations = [];
        calls.push({ table, operations });
        const query = new Proxy({}, {
          get(_target, key) {
            if (key === "then") return (resolve) => resolve({ data: rows[table] ?? [], error: null });
            return (...args) => {
              operations.push([key, ...args]);
              return query;
            };
          }
        });
        return query;
      }
    }
  };
}

const location = {
  id: "station-1",
  station_code: "QLDA",
  station_name: "Koyilandy",
  city: "Koyilandy",
  region: "KL",
  cluster: null,
  cluster_manager: null,
  aom: "Area Manager"
};

test("date selection supports Today, one day, ranges, MTD and legacy month links", () => {
  const module = compile("./adhoc-activity.ts", {
    "server-only": {},
    "@/lib/ops-pulse/performance-review": {},
    "@/lib/ops-pulse/review-trends-data": {},
    "@/lib/supabase-admin": { supabaseAdmin: null }
  });
  assert.deepEqual(module.adHocDateRange({ from: "2026-09-07", to: "2026-09-07" }, "2026-09-07"), {
    from: "2026-09-07", to: "2026-09-07", state: "today"
  });
  assert.deepEqual(module.adHocDateRange({ from: "2026-09-04", to: "2026-09-04" }, "2026-09-07").state, "single");
  assert.deepEqual(module.adHocDateRange({ from: "2026-09-07", to: "2026-09-02" }, "2026-09-07"), {
    from: "2026-09-02", to: "2026-09-07", state: "range"
  });
  assert.deepEqual(module.adHocDateRange({}, "2026-09-07"), {
    from: "2026-09-01", to: "2026-09-07", state: "mtd"
  });
  assert.deepEqual(module.adHocDateRange({ month: "2026-08" }, "2026-09-07"), {
    from: "2026-08-01", to: "2026-08-31", state: "closed"
  });
});

test("AOM is the grouping fallback and only explicit Adhoc Van Cashbook heads qualify", () => {
  const module = compile("./adhoc-activity.ts", {
    "server-only": {},
    "@/lib/ops-pulse/performance-review": {},
    "@/lib/ops-pulse/review-trends-data": {},
    "@/lib/supabase-admin": { supabaseAdmin: null }
  });
  assert.equal(module.adHocClusterLabel(location), "Area Manager");
  assert.equal(module.isCashbookAdHocVan({ category: "Van Adhoc", cps_sub_head: null, expense_type: null }), true);
  assert.equal(module.isCashbookAdHocVan({ category: "Ad-hoc Van", cps_sub_head: null, expense_type: null }), true);
  assert.equal(module.isCashbookAdHocVan({ category: "Station Visits", cps_sub_head: null, expense_type: null }), false);
});

test("today's approved request and Cashbook-only Van are counted, while linked Cashbook is not duplicated", async () => {
  const request = {
    id: "request-1",
    request_no: "PAY12345",
    location_id: "station-1",
    station_code: "QLDA",
    location_code: "QLDA",
    payment_head_id: "van-head",
    work_date: "2026-09-07",
    amount: 150,
    amount_approved: null,
    amount_requested: 150,
    status: "approved",
    approval_status: "FINAL_APPROVED",
    current_approver_user_id: null,
    current_approver_role_id: null
  };
  const cashbook = [
    { id: "cash-1", expense_date: "2026-09-07", station_code: "QLDA", category: "Van Adhoc", cps_sub_head: null, expense_type: null, amount: 150, remarks: "PAY12345", raw_payload: {} },
    { id: "cash-2", expense_date: "2026-09-07", station_code: "QLDA", category: "Adhoc Van", cps_sub_head: null, expense_type: null, amount: 70, remarks: null, raw_payload: {} },
    { id: "cash-3", expense_date: "2026-09-07", station_code: "QLDA", category: "Station Visits", cps_sub_head: null, expense_type: null, amount: 999, remarks: null, raw_payload: {} }
  ];
  const { db, calls } = queryDb({
    payment_heads: [{ id: "van-head", code: "VAN_ADHOC", name: "Adhoc Van" }],
    payment_requests: [request],
    cps_cashbook_daily: cashbook
  });
  const module = compile("./adhoc-activity.ts", {
    "server-only": {},
    "@/lib/ops-pulse/performance-review": {
      isAdHocHead: () => true,
      adHocCategory: () => "Van",
      isApprovedPayment: (row) => row.status === "approved"
    },
    "@/lib/ops-pulse/review-trends-data": { readTrendPages: async (read) => (await read(0)).data },
    "@/lib/supabase-admin": { supabaseAdmin: db }
  });

  const result = await module.loadAdHocActivity("company", [location], "2026-09-07", "2026-09-07");
  assert.equal(result.error, null);
  assert.equal(result.totals.vanCount, 2);
  assert.equal(result.totals.vanAmount, 220);
  assert.equal(result.totals.cashbookVanCount, 2);
  assert.equal(result.totals.cashbookVanAmount, 220);
  assert.equal(result.totals.totalCount, 2);
  assert.equal(result.totals.totalAmount, 220);
  assert.deepEqual(
    calls.filter((call) => call.table === "payment_requests")
      .flatMap((call) => call.operations.filter((operation) => operation[0] === "in").map((operation) => operation[1])),
    ["location_id", "payment_head_id", "station_code", "payment_head_id", "location_code", "payment_head_id"]
  );
});
