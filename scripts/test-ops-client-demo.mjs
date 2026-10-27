import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
function load(file, mocks = {}) {
  const m = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function("require", "module", "exports", js)(
    (id) => {
      if (!(id in mocks)) throw Error(`Unexpected dependency: ${id}`);
      return mocks[id];
    },
    m,
    m.exports,
  );
  return m.exports;
}
const fail = () => {
  throw Error("Demo catalogue must not invoke authorization or data access");
};
const nav = load("src/lib/ops-pulse/navigation.ts", {
  "@/lib/app-navigation": load("src/lib/app-navigation.ts"),
  "@/lib/authorization": { hasPermission: fail, isCompanyOwner: fail },
  "@/lib/ops-pulse/cod-pending-access": { canAccessDailyCodPending: fail },
});
const model = load("src/lib/ops-pulse/demo/catalog.ts");
const surface = load("src/lib/ops-pulse/demo/surface.ts");
export const catalogs = {
  "last-mile": nav.opsNavCatalogForMode("amazon_edsp"),
  "q-commerce": nav.opsNavCatalogForMode("amazon_now"),
};
for (const [workspace, items] of Object.entries(catalogs)) {
  const menus = model.demoMenus(items);
  assert.equal(new Set(menus.map((m) => m.id)).size, menus.length);
  for (const menu of menus) {
    assert.ok(
      model
        .demoLink(workspace, menu.id)
        .startsWith(
          `/demo/${workspace === "last-mile" ? "last-mile" : "dark-store"}`,
        ),
    );
    const rows = model.seedRecords(menu, workspace);
    if (menu.definition.kind !== "dashboard")
      assert.ok(rows.length >= 3, `${workspace}: ${menu.label} needs samples`);
    for (const row of rows) {
      assert.equal(
        row.values.length,
        menu.definition.columns.length,
        menu.label,
      );
      assert.ok(
        row.location.startsWith(workspace === "last-mile" ? "LM" : "QC"),
      );
      assert.ok(row.id.startsWith("SAMPLE-"));
    }
  }
  const payments = menus.filter((m) => m.definition.kind === "payment");
  assert.ok(payments.length > 2);
  assert.deepEqual(
    model.seedRecords(payments[0], workspace),
    model.seedRecords(payments[1], workspace),
  );
  console.log(
    `${workspace}: ${menus.length} populated menu destinations verified`,
  );
}
const q = model.demoMenus(catalogs["q-commerce"]);
for (const href of ["/si-handover?view=start", "/store-ops?view=start"]) {
  const a = q.find((m) => m.href === href),
    b = q.find(
      (m) =>
        m.href ===
        (href.includes("store")
          ? "/si-handover/report?tab=store"
          : "/si-handover/report?tab=shift"),
    );
  assert.deepEqual(
    model.seedRecords(a, "q-commerce").map((r) => r.id),
    model.seedRecords(b, "q-commerce").map((r) => r.id),
  );
}
for (const host of [
  "ops.dropxlogistics.com",
  "localhost:8795",
  "dropx-ops-pulse-demo.vercel.app",
])
  assert.equal(surface.isOpsDemoRequest(host, "/demo", "GET"), true);
for (const host of [
  "dashboard.dropxlogistics.com",
  "people.dropxlogistics.com",
  "evilops.dropxlogistics.com",
  "ops.dropxlogistics.com.evil.test",
])
  assert.equal(surface.isOpsDemoRequest(host, "/demo", "GET"), false);
for (const path of [
  "/demo/api",
  "/payments/approvals",
  "/api/payments",
  "/demo/../payments",
  "/",
])
  assert.equal(
    surface.isOpsDemoRequest("ops.dropxlogistics.com", path, "GET"),
    false,
  );
for (const method of ["POST", "PUT", "PATCH", "DELETE"])
  assert.equal(
    surface.isOpsDemoRequest("ops.dropxlogistics.com", "/demo", method),
    false,
  );
assert.equal(
  model.csvText(["Label"], [["=SUM(1)"], ['a"b']]),
  '"Label"\r\n"\'=SUM(1)"\r\n"a""b"',
);
const client = fs.readFileSync("src/app/demo/workspace.tsx", "utf8");
assert.doesNotMatch(client, /fetch\(|supabase|server-action|\/api\//);
assert.match(client, /sessionStorage/);
const middleware = fs.readFileSync("src/middleware.ts", "utf8");
assert.match(middleware, /connect-src 'none'/);
assert.match(middleware, /form-action 'none'/);
assert.ok(
  middleware.indexOf("if (isOpsDemoRequest") <
    middleware.indexOf("const isOpsHost ="),
);
assert.equal((155000 + 37200 + 18600 + 12400) / 12400, 18);
console.log(
  "Demo isolation, shared sample identities, menu completeness and export checks passed",
);

// Workspace links are independent routes; query strings cannot swap the catalogue.
for (const path of ["/demo/last-mile", "/demo/dark-store"]) {
  assert.equal(
    surface.isOpsDemoRequest("ops.dropxlogistics.com", path, "GET"),
    true,
  );
  assert.equal(
    surface.isOpsDemoRequest("ops.dropxlogistics.com", path, "HEAD"),
    true,
  );
  for (const method of ["POST", "PATCH", "DELETE"])
    assert.equal(
      surface.isOpsDemoRequest("ops.dropxlogistics.com", path, method),
      false,
    );
}
for (const path of [
  "/demo/other",
  "/demo/dark-store/api",
  "/demo/last-mile/payments",
  "/demo/dark-store/../payments",
])
  assert.equal(
    surface.isOpsDemoRequest("ops.dropxlogistics.com", path, "GET"),
    false,
  );
const page = fs.readFileSync("src/app/demo/[business]/page.tsx", "utf8");
assert.match(page, /params.business/);
assert.doesNotMatch(
  page,
  /searchParams|q-commerce.*opsNavCatalogForMode.*amazon_edsp/,
);
assert.doesNotMatch(client, /setWorkspace|Explore your|workspace === w/);
assert.match(client, /AppShellFrame/);
assert.match(client, /OpsDesignNavigation/);
assert.match(client, /trackEvents=\{false\}/);
const runtime = fs.readFileSync(
  "src/app/demo/production-activities.tsx",
  "utf8",
);
assert.doesNotMatch(runtime, /await fetch\(|supabase|liveActions/);
assert.match(runtime, /No live request was made/);
assert.match(runtime, /SiHandoverWorkspace/);
assert.match(runtime, /StoreOpsWorkspace/);
assert.match(runtime, /ActivitiesReportClient/);
console.log(
  "Separate workspace routes and production activity component reuse verified",
);

// Exercise the real checklist rules against the fictional production-screen fixtures.
const shiftModel = load('src/lib/ops-pulse/si-handover/model.ts');
const storeModel = load('src/lib/ops-pulse/store-ops/model.ts', {
  '@/lib/ops-pulse/si-handover/model': shiftModel,
  './location-mailbox': load('src/lib/ops-pulse/store-ops/location-mailbox.ts'),
});
const activities = load('src/lib/ops-pulse/demo/activities.ts', {
  '@/lib/ops-pulse/si-handover/model': shiftModel,
  '@/lib/ops-pulse/store-ops/model': storeModel,
  '@/lib/ops-pulse/si-handover/template': load('src/lib/ops-pulse/si-handover/template.ts', {'./model': shiftModel}),
  '@/lib/ops-pulse/store-ops/template': load('src/lib/ops-pulse/store-ops/template.ts'),
});
const activityState = activities.activitySeed();
assert.equal(activityState.shifts.length, 57);
assert.equal(activityState.stores.length, 21);
assert.equal(new Set(activityState.shifts.map(r => r.id)).size, 57);
for (const row of activityState.shifts) {
  assert.ok(activities.sampleStores.some(s => s.id === row.location_id));
  const pack = activities.activityPack(activityState, 'shift', row.id);
  assert.ok(pack.checklist.store_code.startsWith('SAMPLE'));
  assert.ok(pack.proofs.every(p => p.url === '/demo-assets/evidence.svg'));
  if (row.status !== 'open') shiftModel.validateAnswersForSubmit(row, row.answers, activityState.evidence.filter(p => p.checklist_id === row.id), {city: 'Sample city', settings: shiftModel.defaultSettings()});
}
for (const row of activityState.stores) {
  const gaps = storeModel.collectSubmitGaps(row, row.answers, activityState.evidence.filter(p => p.checklist_id === row.id), {city: 'Sample city', settings: storeModel.defaultSettings(), weeklyDoneIds: new Set(), monthlyDoneIds: new Set()});
  assert.deepEqual(gaps, []);
}
assert.equal(activities.activityPack(activityState, 'shift', 'unknown'), null);
console.log('Production checklist fixtures pass submission rules and sample-export checks');
