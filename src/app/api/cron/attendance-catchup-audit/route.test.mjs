import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as reconciliationPolicy from "../../../../lib/biometric/attendance-reconciliation-policy.ts";
import * as enrolmentResolution from "../../../../lib/biometric/enrolment-resolution.ts";

function compile(sourceUrl, mocks) {
  const module = { exports: {} };
  const source = readFileSync(sourceUrl, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  new Function("require", "exports", "module", output)(
    (name) => {
      if (name in mocks) return mocks[name];
      throw new Error(`Missing test mock: ${name}`);
    },
    module.exports,
    module
  );
  return module.exports;
}

function mapping({
  accountId,
  companyId = "company-a",
  effectiveFrom = "2026-09-01",
  enrolmentId,
  id,
  locationId = "location-a",
  status = "Pending"
}) {
  return {
    account_id: accountId,
    company_id: companyId,
    effective_from: effectiveFrom,
    effective_to: null,
    employee_id: null,
    enrolment_id: enrolmentId,
    field_executive_id: accountId,
    id,
    location_id: locationId,
    profile_type: "field_executive",
    status,
    worker_type: "individual_contract"
  };
}

function auditFixture() {
  return compile(new URL("../../../../lib/biometric/attendance-catchup-audit.ts", import.meta.url), {
    "@/lib/biometric/attendance-reconciliation-policy": reconciliationPolicy,
    "@/lib/biometric/enrolment-resolution": enrolmentResolution,
    "@/lib/supabase-admin": { supabaseAdmin: null },
    "@/lib/supabase-pagination": { readAllRows: async () => ({ data: [], error: null }) }
  });
}

test("catch-up audit matches attendance evidence by punch instant across a night-shift date boundary", () => {
  const source = readFileSync(
    new URL("../../../../lib/biometric/attendance-catchup-audit.ts", import.meta.url),
    "utf8"
  );
  const punchQuery = source.match(
    /admin\.from\("attendance_punches"\)([\s\S]*?)admin\.from\("attendance_daily"\)/
  )?.[1] ?? "";

  assert.match(punchQuery, /\.gte\("punch_time", startAt\)/);
  assert.match(punchQuery, /\.lt\("punch_time", endBefore\)/);
  assert.doesNotMatch(punchQuery, /\.gte\("punch_date", ATTENDANCE_CATCHUP_AUDIT_FROM\)/);
});

test("catch-up audit reports samples without exposing profile identity and classifies every raw gap", () => {
  const audit = auditFixture();
  const result = audit.buildAttendanceCatchupAudit({
    companyId: "company-a",
    workforceRows: [
      {
        biometric_id: "001201",
        company_id: "company-a",
        dropx_id: "kgqc1201",
        id: "person-kg",
        is_active: true,
        lifecycle_status: "Active",
        onboarding_status: "approved",
        source_profile_id: "legacy-kg",
        source_profile_type: "field_executive"
      },
      {
        biometric_id: "000096",
        company_id: "company-a",
        dropx_id: "PEUA8096",
        id: "person-pe",
        is_active: false,
        lifecycle_status: "Pending",
        onboarding_status: "pending",
        source_profile_id: null,
        source_profile_type: "field_executive"
      }
    ],
    mappings: [
      mapping({ accountId: "legacy-kg", enrolmentId: "0001201", id: "mapping-kg", status: "Active" }),
      mapping({ accountId: "person-pe", enrolmentId: "96", id: "mapping-pe" }),
      mapping({ accountId: "person-a", enrolmentId: "77", id: "mapping-ambiguous-a" }),
      mapping({ accountId: "person-b", enrolmentId: "077", id: "mapping-ambiguous-b" }),
      mapping({ accountId: "person-incomplete", enrolmentId: "99", id: "mapping-incomplete", locationId: null })
    ],
    rawRows: [
      { company_id: "company-a", device_serial: "device-a", enrolment_id: "1201", id: "raw-linked", punch_time: "2026-09-02T02:30:00.000Z" },
      { company_id: "company-a", device_serial: "device-a", enrolment_id: "001201", id: "raw-timestamp", punch_time: "2026-09-03T02:30:00.000Z" },
      { company_id: "company-a", device_serial: "device-a", enrolment_id: "1201", id: "raw-safe-kg", punch_time: "2026-09-04T02:30:00.000Z" },
      { company_id: "company-a", device_serial: "device-a", enrolment_id: "096", id: "raw-safe-pe", punch_time: "2026-09-04T03:30:00.000Z" },
      { company_id: "company-a", device_serial: "device-a", enrolment_id: "77", id: "raw-ambiguous", punch_time: "2026-09-04T04:30:00.000Z" },
      { company_id: "company-a", device_serial: "device-a", enrolment_id: "88", id: "raw-unmapped", punch_time: "2026-09-04T05:30:00.000Z" },
      { company_id: "company-a", device_serial: "device-a", enrolment_id: "99", id: "raw-incomplete", punch_time: "2026-09-04T06:30:00.000Z" }
    ],
    punchRows: [
      {
        account_id: "legacy-kg",
        calculated: true,
        company_id: "company-a",
        device_serial: "device-a",
        employee_id: null,
        enrolment_id: "001201",
        field_executive_id: "legacy-kg",
        location_id: "location-a",
        profile_type: "field_executive",
        punch_date: "2026-09-02",
        punch_time: "2026-09-02T02:30:00.000Z",
        raw_event_id: "raw-linked",
        worker_type: "individual_contract"
      },
      {
        account_id: "legacy-kg",
        calculated: true,
        company_id: "company-a",
        device_serial: "device-a",
        employee_id: null,
        enrolment_id: "1201",
        field_executive_id: "legacy-kg",
        location_id: "location-a",
        profile_type: "field_executive",
        punch_date: "2026-09-03",
        punch_time: "2026-09-03T02:30:00.000Z",
        raw_event_id: "raw-timestamp",
        worker_type: "individual_contract"
      },
      {
        account_id: "person-pe",
        calculated: false,
        company_id: "company-a",
        device_serial: "device-a",
        employee_id: null,
        enrolment_id: "96",
        field_executive_id: "person-pe",
        location_id: "location-a",
        profile_type: "field_executive",
        punch_date: "2026-09-04",
        punch_time: "2026-09-04T03:30:00.000Z",
        raw_event_id: "raw-safe-pe",
        worker_type: "individual_contract"
      }
    ],
    dailyRows: [
      { company_id: "company-a", enrolment_id: "1201", punch_date: "2026-09-02" },
      { company_id: "company-a", enrolment_id: "001201", punch_date: "2026-09-02" }
    ]
  });

  assert.deepEqual(result.global, {
    ambiguousUnresolvedCount: 1,
    capturedRawCount: 2,
    incompleteMappingUnresolvedCount: 1,
    rawTimelogCount: 7,
    safeMappedUnresolvedCount: 2,
    unmappedUnresolvedCount: 1,
    unresolvedRawCount: 5
  });
  assert.deepEqual(result.window, {
    from: "2026-09-01",
    timeZone: "Asia/Kolkata",
    to: "2026-10-11"
  });
  assert.deepEqual(result.samples[0], {
    calculatedAttendancePunchCount: 2,
    distinctAttendanceDailyDays: 1,
    dropxId: "KGQC1201",
    normalizedBiometricIds: ["1201"],
    profileFound: true,
    profileStatuses: ["Active"],
    profileTypes: ["field_executive"],
    rawTimelogCount: 3,
    uncapturedRawCount: 1
  });
  assert.equal(result.samples[1].profileStatuses[0], "Pending");
  assert.equal(result.samples[1].uncapturedRawCount, 1);
  assert.equal(result.samples[2].profileFound, false);
  assert.equal(result.samples[3].profileFound, false);
  assert.doesNotMatch(JSON.stringify(result), /person-|legacy-|location-/);
});

test("raw capture requires the linked event, device, resolved owner, and resolved location", () => {
  const audit = auditFixture();
  const rawRows = [
    ["raw-good", "device-a", "2026-09-02T02:30:00.000Z"],
    ["raw-wrong-device", "device-a", "2026-09-03T02:30:00.000Z"],
    ["raw-wrong-owner", "device-a", "2026-09-04T02:30:00.000Z"],
    ["raw-wrong-location", "device-a", "2026-09-05T02:30:00.000Z"],
    ["raw-unlinked", "device-a", "2026-09-06T02:30:00.000Z"]
  ].map(([id, device_serial, punch_time]) => ({
    company_id: "company-a",
    device_serial,
    enrolment_id: "1201",
    id,
    punch_time
  }));
  const punch = ({ deviceSerial = "device-a", locationId = "location-a", owner = "person-a", rawEventId, time }) => ({
    account_id: owner,
    calculated: true,
    company_id: "company-a",
    device_serial: deviceSerial,
    employee_id: null,
    enrolment_id: "001201",
    field_executive_id: owner,
    location_id: locationId,
    profile_type: "field_executive",
    punch_date: time.slice(0, 10),
    punch_time: time,
    raw_event_id: rawEventId,
    worker_type: "individual_contract"
  });
  const result = audit.buildAttendanceCatchupAudit({
    companyId: "company-a",
    dailyRows: [],
    mappings: [mapping({ accountId: "person-a", enrolmentId: "1201", id: "mapping-a" })],
    punchRows: [
      punch({ rawEventId: "raw-good", time: rawRows[0].punch_time }),
      punch({ deviceSerial: "device-b", rawEventId: "raw-wrong-device", time: rawRows[1].punch_time }),
      punch({ owner: "person-b", rawEventId: "raw-wrong-owner", time: rawRows[2].punch_time }),
      punch({ locationId: "location-b", rawEventId: "raw-wrong-location", time: rawRows[3].punch_time }),
      punch({ rawEventId: null, time: rawRows[4].punch_time })
    ],
    rawRows,
    workforceRows: [{
      biometric_id: "001201",
      company_id: "company-a",
      dropx_id: "KGQC1201",
      id: "person-a",
      is_active: true,
      lifecycle_status: "Active",
      onboarding_status: "approved",
      source_profile_id: null,
      source_profile_type: "field_executive"
    }]
  });

  assert.equal(result.global.capturedRawCount, 1);
  assert.equal(result.global.safeMappedUnresolvedCount, 4);
  assert.equal(result.global.unresolvedRawCount, 4);
  assert.equal(result.samples[0].uncapturedRawCount, 4);
});

test("sample lookup normalizes DropX IDs inside one explicit tenant scope", () => {
  const audit = auditFixture();
  const profile = (company_id, dropx_id, id) => ({
    biometric_id: "1201",
    company_id,
    dropx_id,
    id,
    is_active: true,
    lifecycle_status: "Active",
    onboarding_status: "approved",
    source_profile_id: null,
    source_profile_type: "field_executive"
  });

  const scoped = audit.scopeAttendanceCatchupAuditWorkforceRows([
    profile("company-a", " kgqc1201 ", "person-a"),
    profile("company-a", "PeUa8096", "person-b"),
    profile("company-a", "not-requested", "person-c"),
    profile("company-b", "KGQC1201", "person-d")
  ], "company-a");
  assert.deepEqual(scoped.map((row) => row.id), ["person-a", "person-b"]);
});

test("audit aggregation ignores rows outside its resolved company scope", () => {
  const audit = auditFixture();
  const result = audit.buildAttendanceCatchupAudit({
    companyId: "company-a",
    dailyRows: [
      { company_id: "company-a", enrolment_id: "1201", punch_date: "2026-09-02" },
      { company_id: "company-b", enrolment_id: "1201", punch_date: "2026-09-03" }
    ],
    mappings: [
      mapping({ accountId: "person-a", companyId: "company-a", enrolmentId: "1201", id: "mapping-a" }),
      mapping({ accountId: "person-b", companyId: "company-b", enrolmentId: "1201", id: "mapping-b" })
    ],
    punchRows: [],
    rawRows: [
      { company_id: "company-a", device_serial: "device-a", enrolment_id: "1201", id: "raw-a", punch_time: "2026-09-02T02:30:00.000Z" },
      { company_id: "company-b", device_serial: "device-b", enrolment_id: "1201", id: "raw-b", punch_time: "2026-09-03T02:30:00.000Z" }
    ],
    workforceRows: [
      {
        biometric_id: "1201", company_id: "company-a", dropx_id: "kgqc1201", id: "person-a",
        is_active: true, lifecycle_status: "Active", onboarding_status: "approved",
        source_profile_id: null, source_profile_type: "field_executive"
      },
      {
        biometric_id: "1201", company_id: "company-b", dropx_id: "KGQC1201", id: "person-b",
        is_active: false, lifecycle_status: "Inactive", onboarding_status: "approved",
        source_profile_id: null, source_profile_type: "field_executive"
      }
    ]
  });

  assert.equal(result.global.rawTimelogCount, 1);
  assert.equal(result.samples[0].rawTimelogCount, 1);
  assert.deepEqual(result.samples[0].profileStatuses, ["Active"]);
  assert.equal(result.samples[0].distinctAttendanceDailyDays, 1);
});

test("audit route requires CRON_SECRET, disables caching, and emits one aggregate log", async () => {
  const calls = [];
  const logs = [];
  const audit = {
    generatedAt: "2026-10-11T00:00:00.000Z",
    global: { rawTimelogCount: 4, unresolvedRawCount: 0 },
    samples: [],
    window: { from: "2026-09-01", timeZone: "Asia/Kolkata", to: "2026-10-11" }
  };
  const route = compile(new URL("./route.ts", import.meta.url), {
    "@/lib/biometric/attendance-catchup-audit": {
      loadAttendanceCatchupAudit: async () => {
        calls.push("load");
        return audit;
      }
    },
    "next/server": {
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), {
            ...init,
            headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
          });
        }
      }
    }
  });
  const priorSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "audit-secret";
  const priorInfo = console.info;
  console.info = (message) => logs.push(JSON.parse(message));
  try {
    const unauthorized = await route.GET(new Request("https://dashboard.dropxlogistics.com/api/cron/attendance-catchup-audit"));
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("cache-control"), "private, no-store");
    assert.equal(calls.length, 0);

    const authorized = await route.GET(new Request("https://dashboard.dropxlogistics.com/api/cron/attendance-catchup-audit", {
      headers: { Authorization: "Bearer audit-secret" }
    }));
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await authorized.json(), audit);
    assert.deepEqual(calls, ["load"]);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].event, "attendance_catchup_audit_completed");
    assert.deepEqual(logs[0].global, audit.global);
  } finally {
    console.info = priorInfo;
    if (priorSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = priorSecret;
  }
});

test("audit endpoint is fixed to the requested IDs and does not accept an expanded user query", () => {
  const source = readFileSync(new URL("../../../../lib/biometric/attendance-catchup-audit.ts", import.meta.url), "utf8");
  const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  for (const dropxId of ["KGQC1201", "PEUA8096", "DROPX1143", "DF1088"]) {
    assert.match(source, new RegExp(`"${dropxId}"`));
  }
  assert.match(source, /\.ilike\("dropx_id"/);
  assert.match(source, /\.eq\("company_id", companyId\)[\s\S]*?\.ilike\("dropx_id"/);
  assert.doesNotMatch(source, /\.in\("dropx_id"/);
  assert.doesNotMatch(routeSource, /searchParams|request\.json|request\.formData/);
  assert.doesNotMatch(source, /full_name|bank_account|mobile|email|aadhaar|pan_number/);
});
