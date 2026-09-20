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

test("submitted utilization is counted before final payment approval", () => {
  const module = compile("./adhoc-activity.ts", {
    "server-only": {},
    "@/lib/ops-pulse/performance-review": {},
    "@/lib/ops-pulse/review-trends-data": {},
    "@/lib/supabase-admin": { supabaseAdmin: null }
  });
  for (const [status, approval] of [
    ["pending", "PENDING"], ["resubmitted", "RE_PENDING"],
    ["OPERATIONS_CLM_APPROVED", "OPERATIONS_CLM_APPROVED"],
    ["approved", "FINAL_APPROVED"], ["processing", "PROCESSING"],
    ["processed", "PROCESSED"]
  ]) assert.equal(module.isSubmittedAdHocUsage({ status, approval_status: approval }), true, status);
  for (const state of ["draft", "rejected", "returned", "cancelled", ""])
    assert.equal(module.isSubmittedAdHocUsage({ status: state, approval_status: state.toUpperCase() }), false, state);
});

test("today's submitted request and Cashbook-only Van are counted, while linked Cashbook is not duplicated", async () => {
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
    current_approver_role_id: null,
    remarks: "Manager approved the additional vehicle",
    notes: null,
    details: { reason: "Volume exceeded the planned vehicle capacity" },
    payment_request_answers: [
      { answer_value: "2026-09-07", payment_head_questions: { question_text: "Deployment date" } },
      { answer_value: "Regular vehicle breakdown", payment_head_questions: { question_text: "Reason for adhoc deployment" } }
    ]
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
      isApprovedPayment: (row) => row.status === "approved",
      paymentReason: (row) => row.remarks || "Reason not recorded in the request"
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
  assert.deepEqual(result.stations[0].days[0].entries.map((entry) => ({
    source: entry.source,
    reference: entry.reference,
    reason: entry.reason,
    remark: entry.remark,
    countedInTotal: entry.countedInTotal
  })), [
    {
      source: "Payment request",
      reference: "PAY12345",
      reason: "Regular vehicle breakdown",
      remark: "Manager approved the additional vehicle",
      countedInTotal: true
    },
    {
      source: "Cashbook",
      reference: "PAY12345",
      reason: "Van Adhoc",
      remark: "PAY12345",
      countedInTotal: false
    },
    {
      source: "Cashbook",
      reference: "cash-2",
      reason: "Adhoc Van",
      remark: "No remark recorded",
      countedInTotal: true
    }
  ]);
  assert.deepEqual(
    calls.filter((call) => call.table === "payment_requests")
      .flatMap((call) => call.operations.filter((operation) => operation[0] === "in").map((operation) => operation[1])),
    ["location_id", "payment_head_id", "station_code", "payment_head_id", "location_code", "payment_head_id"]
  );
});

test("station sorting covers every summary column without mutating the source rows", () => {
  const module = compile("./adhoc-activity-sort.ts");
  const stations = [
    { code: "ZZZ", vanCount: 1, vanAmount: 200, daCount: 4, daAmount: 80, totalCount: 5, totalAmount: 280 },
    { code: "AAA", vanCount: 3, vanAmount: 150, daCount: 2, daAmount: 300, totalCount: 5, totalAmount: 450 },
    { code: "MMM", vanCount: 2, vanAmount: 100, daCount: 1, daAmount: 50, totalCount: 3, totalAmount: 150 }
  ];
  const originalOrder = stations.map((station) => station.code);

  assert.deepEqual(module.sortAdHocStations(stations, "station", "asc").map((station) => station.code), ["AAA", "MMM", "ZZZ"]);
  for (const key of ["vanCount", "vanAmount", "daCount", "daAmount", "totalCount", "totalAmount"]) {
    const values = module.sortAdHocStations(stations, key, "desc").map((station) => station[key]);
    assert.deepEqual(values, [...values].sort((left, right) => right - left), `${key} should sort descending`);
  }
  assert.deepEqual(stations.map((station) => station.code), originalOrder);
  assert.equal(module.validAdHocSortKey("unknown"), "totalAmount");
  assert.equal(module.validAdHocSortDirection("unexpected"), "desc");
});

const hoLocation = { ...location, id: "head-office", station_code: "HQ_NEW", location_models: { code: "DROPX_HO", name: "DROPX HO" } };
const nowLocation = { ...location, id: "amazon-now", station_code: "TCC3", location_models: [{ code: "NOW", name: "NOW" }] };
const helperMocks = {
  "server-only": {},
  "@/lib/ops-pulse/performance-review": {},
  "@/lib/ops-pulse/review-trends-data": {},
  "@/lib/supabase-admin": { supabaseAdmin: null }
};

test("Adhoc scope excludes master-classified HO/Now and legacy HO codes, retaining other station models", () => {
  const { isAdHocActivityLocation: eligible } = compile("./adhoc-activity.ts", helperMocks);
  for (const row of [hoLocation, nowLocation,
    { ...location, station_code: "HO_TS" },
    { ...location, station_code: " ho " },
    { ...location, location_models: { code: null, name: "Amazon Now" } },
    { ...location, location_models: { code: "new-code", name: "Head Office" } }
  ]) assert.equal(eligible(row), false, JSON.stringify(row));
  for (const code of ["EDSP", "XPT", "AMXL", "MDH", "ODH"]) {
    assert.equal(eligible({ ...location, location_models: { code, name: code } }), true, code);
  }
  assert.equal(eligible({ ...location, station_code: "HOSUR", location_models: null }), true, "HO prefix alone must not exclude ordinary station names");
});

test("excluded locations never enter queries, totals, day details or legacy-code fallbacks", async () => {
  const request = { id: "request-ok", location_id: location.id, station_code: "QLDA", work_date: "2026-09-07", payment_head_id: "van", status: "approved", amount: 100 };
  const { db, calls } = queryDb({
    payment_heads: [{ id: "van", code: "VAN_ADHOC", name: "Adhoc Van" }],
    payment_requests: [request,
      { ...request, id: "request-ho", location_id: hoLocation.id, station_code: "HQ_NEW", amount: 500 },
      { ...request, id: "request-now-conflict", location_id: nowLocation.id, station_code: "QLDA", amount: 600 },
      { ...request, id: "request-now-code", location_id: null, station_code: "TCC3", amount: 700 },
      { ...request, id: "request-legacy-ok", location_id: null, station_code: null, location_code: "QLDA", amount: 50 }
    ],
    cps_cashbook_daily: [
      { id: "cash-ok", station_code: "QLDA", expense_date: "2026-09-07", category: "Van Adhoc", amount: 20 },
      { id: "cash-ho", station_code: "HQ_NEW", expense_date: "2026-09-07", category: "Van Adhoc", amount: 900 },
      { id: "cash-now", station_code: "TCC3", expense_date: "2026-09-07", category: "Van Adhoc", amount: 800 }
    ]
  });
  const module = compile("./adhoc-activity.ts", {
    ...helperMocks,
    "@/lib/supabase-admin": { supabaseAdmin: db },
    "@/lib/ops-pulse/review-trends-data": { readTrendPages: async read => (await read(0)).data },
    "@/lib/ops-pulse/performance-review": { isAdHocHead: () => true, adHocCategory: () => "Van", isApprovedPayment: () => true, paymentReason: () => "Reason" }
  });
  const result = await module.loadAdHocActivity("company", [location, hoLocation, nowLocation], "2026-09-07", "2026-09-07");
  assert.deepEqual(result.stations.map(row => row.code), ["QLDA"]);
  assert.equal(result.totals.totalAmount, 170);
  assert.equal(result.totals.totalCount, 3);
  assert.equal(result.totals.activeStations, 1);
  assert.deepEqual(result.stations[0].days[0].entries.map(row => row.id), ["request-ok", "request-legacy-ok", "cash-ok"]);
  for (const { operations } of calls) for (const [op, field, values] of operations) {
    if (op === "in" && ["location_id", "station_code", "location_code"].includes(field)) {
      assert.deepEqual(values, field === "location_id" ? [location.id] : ["QLDA"]);
    }
  }
  calls.length = 0;
  const empty = await module.loadAdHocActivity("company", [hoLocation, nowLocation], "2026-09-07", "2026-09-07");
  assert.deepEqual(empty.stations, []);
  assert.equal(empty.totals.totalCount, 0);
  assert.equal(calls.length, 0, "excluded-only scope must not query payments");
});

test("Excel endpoint applies the same master exclusion, including direct excluded-only URLs", async () => {
  const helpers = compile("./adhoc-activity.ts", helperMocks);
  const sort = compile("./adhoc-activity-sort.ts");
  let permitted = true;
  const selected = [];
  const endpoint = compile("../../app/api/ops-pulse/cps/adhoc-activity/report/route.ts", {
    "@/lib/authorization": { getAuthorization: async () => ({ locationScopeIds: [location.id], hasAllLocationAccess: false }), hasPermission: () => permitted },
    "@/lib/company-scope": { requireCompanyId: () => "company" },
    "@/lib/ops-pulse/cod": { todayKolkata: () => "2026-09-11", loadCodLocations: async (company, ids, all) => {
      assert.equal(company, "company"); assert.deepEqual(ids, [location.id]); assert.equal(all, false);
      return { locations: [location, hoLocation, nowLocation], error: null };
    } },
    "@/lib/ops-pulse/adhoc-activity": { ...helpers, loadAdHocActivity: async (_company, locations) => {
      selected.push(locations.map(row => row.station_code));
      return { stations: [], totals: {}, error: null };
    } },
    "@/lib/ops-pulse/adhoc-activity-sort": sort,
    "@/lib/report-workbook": { workbookResponse: sheets => Response.json(sheets) }
  });
  const response = await endpoint.GET(new Request("https://ops.dropxlogistics.com/api/ops-pulse/cps/adhoc-activity/report?stations=QLDA,HQ_NEW,TCC3"));
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].rows[0]["Selected stations"], 1);
  assert.deepEqual(selected[0], ["QLDA"]);
  await endpoint.GET(new Request("https://ops.dropxlogistics.com/api/ops-pulse/cps/adhoc-activity/report?stations=HQ_NEW,TCC3"));
  assert.deepEqual(selected[1], [], "excluded-only selection must not widen to all locations");
  permitted = false;
  assert.equal((await endpoint.GET(new Request("https://ops.dropxlogistics.com/api/ops-pulse/cps/adhoc-activity/report"))).status, 403);
  assert.equal(selected.length, 2);
});
