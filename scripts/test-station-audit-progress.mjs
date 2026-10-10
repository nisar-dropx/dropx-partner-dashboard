import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
const require = createRequire(import.meta.url);
const cache = new Map();
function load(file, mocks = {}) {
  const absolute = path.resolve(file);
  if (cache.has(absolute) && !Object.keys(mocks).length)
    return cache.get(absolute);
  const mod = { exports: {} };
  const result = ts.transpileModule(fs.readFileSync(absolute, "utf8"), {
    fileName: absolute,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  assert.equal(
    result.diagnostics?.length || 0,
    0,
    JSON.stringify(result.diagnostics),
  );
  new Function("require", "module", "exports", result.outputText)(
    (id) =>
      id in mocks
        ? mocks[id]
        : id.startsWith(".")
          ? load(path.resolve(path.dirname(absolute), id + ".ts"))
          : id.startsWith("@/lib/ops-pulse/")
            ? load("src/lib/ops-pulse/" + id.split("/").at(-1) + ".ts")
            : require(id),
    mod,
    mod.exports,
  );
  if (!Object.keys(mocks).length) cache.set(absolute, mod.exports);
  return mod.exports;
}
const p = load("src/lib/ops-pulse/station-audit-progress.ts");
const { allAuditRows, auditRowsForIds } = load(
  "src/lib/ops-pulse/station-audit-query.ts",
);
const now = Date.parse("2026-10-10T12:00:00+05:30");
const audit = (patch = {}) => ({
  id: "1",
  location_id: "A",
  audit_number: "AUD-1",
  audit_type_id: "COD",
  status_code: "scheduled",
  assigned_to: "person1",
  assigned_name: "Same name",
  assignment_verified: true,
  scheduled_for: "2026-10-08T12:00:00+05:30",
  station_response_status: "not_requested",
  ...patch,
});
assert.equal(
  p.auditReportRangeError("2026-02-30", "2026-03-01").length > 0,
  true,
);
assert.ok(p.auditReportRangeError("2026-10-12", "2026-10-01"));
assert.equal(p.auditReportRangeError("2026-09-28", "2026-10-10"), "");
assert.ok(p.auditReportRangeError("2025-01-01", "2026-10-10"));
assert.equal(
  p.inAuditReportRange(
    audit({ scheduled_for: "2026-09-30T18:30:00Z" }),
    "2026-10-01",
    "2026-10-01",
  ),
  true,
);
assert.equal(
  p.inAuditReportRange(
    audit({ scheduled_for: "2026-10-01T18:30:00Z" }),
    "2026-10-01",
    "2026-10-01",
  ),
  false,
);
const rows = [
  audit(),
  audit({
    id: "2",
    status_code: "in_progress",
    started_at: "2026-10-08T12:00:00+05:30",
  }),
  audit({
    id: "3",
    status_code: "under_review",
    completed_at: "2026-10-09",
    station_response_status: "submitted",
  }),
  audit({ id: "4", status_code: "closed", completed_at: "2026-10-09" }),
  audit({
    id: "5",
    status_code: "awaiting_station_response",
    completed_at: "2026-10-09",
    station_response_status: "requested",
    response_due_at: "2026-10-10T11:00:00+05:30",
  }),
  audit({
    id: "6",
    scheduled_for: "2026-10-11T12:00:00+05:30",
    assigned_to: "person2",
  }),
];
const summary = p.summarizeAuditProgress(rows, now);
assert.deepEqual(summary, {
  total: 6,
  completed: 1,
  incomplete: 5,
  submitted: 3,
  notSubmitted: 3,
  overdue: 2,
  upcoming: 1,
  responsePending: 1,
  responseOverdue: 1,
  waitingReview: 1,
  completionRate: 1 / 6,
});
assert.equal(p.auditProgress(rows[0], now).daysOverdue, 2);
assert.equal(p.matchesAuditReportStatus(rows[2], "complete", now), false);
assert.equal(p.matchesAuditReportStatus(rows[2], "followup", now), true);
assert.equal(p.auditProgress(rows[5], now).overdue, false);
assert.equal(
  p.auditProgress(audit({ scheduled_for: "2026-10-10T11:59:00+05:30" }), now)
    .overdue,
  true,
);
const many = Array.from({ length: 1201 }, (_, i) => ({ id: i }));
assert.equal(
  (
    await allAuditRows((from, to) =>
      Promise.resolve({ data: many.slice(from, to + 1), error: null }),
    )
  ).data.length,
  1201,
);
assert.equal(
  (
    await allAuditRows((from, to) =>
      Promise.resolve(
        from
          ? { data: null, error: { message: "failed" } }
          : { data: many.slice(from, to + 1), error: null },
      ),
    )
  ).data,
  null,
);
let batches = [];
assert.equal(
  (
    await auditRowsForIds(
      many.map((r) => String(r.id)),
      (ids) => {
        batches.push(ids.length);
        return Promise.resolve({ data: ids, error: null });
      },
    )
  ).data.length,
  1201,
);
assert.ok(batches.every((n) => n <= 100));
const XLSX = require("xlsx");
const { appendAuditProgressSummary, auditWorkbookSheet } = load(
  "src/lib/ops-pulse/station-audit-progress-export.ts",
);
const book = XLSX.utils.book_new();
appendAuditProgressSummary(book, rows, {
  from: "2026-10-01",
  to: "2026-10-31",
  now,
  stations: [
    { id: "A", station_code: "STA" },
    { id: "B", station_code: "STB" },
  ],
  filters: "All",
  auditorName: (a) => a.assigned_name,
  register: rows.map((a) => ({ "Audit number": a.audit_number, ID: a.id })),
});
const roundtrip = XLSX.read(
  XLSX.write(book, { bookType: "xlsx", type: "buffer" }),
  { type: "buffer" },
);
assert.deepEqual(roundtrip.SheetNames, [
  "Overview",
  "Station summary",
  "Auditor summary",
  "Follow-up",
]);
assert.equal(
  XLSX.utils.sheet_to_json(roundtrip.Sheets.Overview)[0]["Not completed"],
  5,
);
assert.equal(
  XLSX.utils.sheet_to_json(roundtrip.Sheets["Station summary"])[1][
    "Total audits"
  ],
  0,
);
assert.equal(
  XLSX.utils.sheet_to_json(roundtrip.Sheets["Auditor summary"]).length,
  2,
  "same-name people must remain distinct",
);
assert.equal(XLSX.utils.sheet_to_json(roundtrip.Sheets["Follow-up"]).length, 5);

// Exercise the real export route with a paginated, tenant-aware query fixture.
let auth = { userId: "owner" };
let manager = true;
let failPage = false;
const queries = [];
const fixture = Array.from({ length: 1201 }, (_, i) =>
  audit({
    id: String(i),
    company_id: "tenant",
    audit_number: `AUD-${i}`,
    scheduled_for: "2026-10-08T06:30:00Z",
    ops_audit_types: { name: "COD" },
  }),
);
fixture.push(
  audit({ id: "outside", company_id: "tenant", location_id: "B" }),
  audit({ id: "other-tenant", company_id: "other" }),
  audit({
    id: "past",
    company_id: "tenant",
    scheduled_for: "2026-09-28T06:30:00Z",
  }),
);
const longHistory = "Shipment update 🚚 " + "TID1234567890,".repeat(9000);
const historyFixture = [
  {
    audit_id: "0",
    company_id: "tenant",
    event_type: "updated",
    actor_name: "Audit reviewer",
    created_at: "2026-10-08T06:30:00Z",
    before_data: { shipment_ids: longHistory },
    after_data: { note: longHistory },
  },
];
const db = {
  from(table) {
    const filters = [];
    let first = 0,
      last = 499;
    const q = {
      select() {
        return q;
      },
      eq(k, v) {
        filters.push((r) => r[k] === v);
        return q;
      },
      is(k, v) {
        filters.push((r) => (r[k] ?? null) === v);
        return q;
      },
      in(k, v) {
        filters.push((r) => v.includes(r[k]));
        return q;
      },
      gte(k, v) {
        filters.push((r) => Date.parse(r[k]) >= Date.parse(v));
        return q;
      },
      lte(k, v) {
        filters.push((r) => Date.parse(r[k]) <= Date.parse(v));
        return q;
      },
      order() {
        return q;
      },
      range(a, b) {
        first = a;
        last = b;
        return q;
      },
      then(resolve) {
        queries.push({ table, first, last });
        return Promise.resolve(
          failPage && table === "ops_station_audits" && first === 500
            ? { data: null, error: { message: "page failed" } }
            : {
                data: (table === "ops_station_audits"
                  ? fixture
                  : table === "ops_station_audit_events"
                    ? historyFixture
                    : []
                )
                  .filter((r) => filters.every((f) => f(r)))
                  .slice(first, last + 1),
                error: null,
              },
        ).then(resolve);
      },
    };
    return q;
  },
};
const route = load("src/app/api/ops-pulse/audits/export/route.ts", {
  "@/lib/supabase-admin": { supabaseAdmin: db },
  "@/lib/authorization": {
    getAuthorization: async () => auth,
    hasPermission: () => Boolean(auth),
  },
  "@/lib/company-scope": { requireCompanyId: () => "tenant" },
  "@/lib/ops-pulse/station-audits": {
    canManageStationAudits: () => manager,
    loadAuditStations: async () => [{ id: "A", station_code: "STA" }],
    loadStationAuditMaster: async () => ({
      programmeSettings: { scheduler_role_ids: [] },
      auditTypes: [{ id: "COD", name: "COD" }],
    }),
  },
  "@/lib/ops-pulse/station-audit-people": {
    loadAuditAssignees: async () => [{ id: "person1", name: "Current Name" }],
  },
});
const get = (params = "") =>
  route.GET(
    new Request(
      "https://ops.dropxlogistics.com/api/ops-pulse/audits/export?from=2026-10-01&to=2026-10-10" +
        params,
    ),
  );
let response = await get();
assert.equal(response.status, 200);
const out = XLSX.read(Buffer.from(await response.arrayBuffer()), {
  type: "buffer",
});
const register = XLSX.utils.sheet_to_json(out.Sheets["Audit register"]);
assert.equal(register.length, 1201);
assert.ok(register.every((r) => r.Station === "STA"));
assert.equal(register[0]["Assigned auditor"], "Current Name");
const history = XLSX.utils.sheet_to_json(out.Sheets["Audit history"])[0];
assert.equal(
  Object.entries(history)
    .filter(([key]) => key === "Before" || key.startsWith("Before (continued"))
    .map(([, value]) => value)
    .join(""),
  JSON.stringify(historyFixture[0].before_data),
);
assert.ok(
  Object.values(history).every(
    (value) => typeof value !== "string" || value.length <= 32767,
  ),
);
assert.equal((await get("&format=invalid")).status, 400);
assert.equal((await get("&stations=B")).status, 403);
manager = false;
assert.equal((await get()).status, 403);
manager = true;
auth = null;
assert.equal((await get()).status, 403);
auth = { userId: "owner" };
failPage = true;
assert.equal(
  (await get()).status,
  500,
  "never silently export incomplete data",
);
failPage = false;
assert.equal((await get("&status=complete")).status, 200);
fs.writeFileSync(
  "/tmp/audit-progress-test.xlsx",
  XLSX.write(out, { bookType: "xlsx", type: "buffer" }),
);
console.log(
  "Audit progress tests passed: IST date boundaries, multi-month ranges, truthful completion, overdue and response states, same-name auditor identity, 1,201-row export, batching, summary workbook roundtrip, tenant/location scope, manager access and failed-page handling.",
);

// Round-trip the long-text failure and verify every character is preserved.
const unicode = "🚚".repeat(34000);
const longSheet = auditWorkbookSheet([{ Notes: "Short" }, { Notes: unicode }]);
const longBook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(longBook, longSheet, "Long text");
const longOut = XLSX.utils.sheet_to_json(
  XLSX.read(XLSX.write(longBook, { type: "buffer", bookType: "xlsx" }), {
    type: "buffer",
  }).Sheets["Long text"],
)[1];
assert.equal(Object.values(longOut).join(""), unicode);
const { PDFDocument } = require("pdf-lib");
response = await get("&format=pdf");
assert.equal(response.status, 200);
assert.equal(response.headers.get("Content-Type"), "application/pdf");
const pdf = Buffer.from(await response.arrayBuffer());
assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
const parsed = await PDFDocument.load(pdf);
assert.ok(parsed.getPageCount() > 4, "large report must paginate");
fs.writeFileSync("/tmp/audit-progress-test.pdf", pdf);
response = await get("&format=pdf&status=complete");
assert.equal(response.status, 200);
assert.ok(
  (await PDFDocument.load(await response.arrayBuffer())).getPageCount() >= 4,
);
console.log(
  "Long history and emoji text preserved across Excel continuation columns; full and empty filtered PDF exports validated.",
);
