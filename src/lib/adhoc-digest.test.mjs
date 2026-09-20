import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
function compile(path, mocks = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  new Function("require", "exports", "module", code)(name => name in mocks ? mocks[name] : require(name), module.exports, module);
  return module.exports;
}
const scope = compile("./adhoc-digest-scope.ts");
const digest = compile("./adhoc-digest.ts", {
  "./ops-pulse/adhoc-activity": {}, "./adhoc-digest-scope": scope
});
const station = (id, provider = "AMAZON", model = "EDSP", region = "KL") => ({ id, station_code: id.toUpperCase(), station_name: id, cluster: "Test cluster", region, state: region === "KL" ? "Kerala" : region === "AP" ? "Andhra Pradesh" : "Odisha", providers: { code: provider }, location_models: { code: model } });
const entry = (category, amount, extra = {}) => ({ category, amount, countedInTotal: true, ...extra });
const activity = (id, days) => ({ id, code: id.toUpperCase(), days });
const options = {
  date: "2026-09-11", checkedAt: "2026-09-12T02:30:00Z", subjectTemplate: "Ad hoc usage | {{month}} {{year}}",
  stations: [station("a"), station("b", "AMAZON", "EDSP", "AP"), station("now", "AMAZON", "NOW"), station("flip", "FLIPKART", "MDH", "ODCG")],
  recipients: [{ email: "manager@example.com", name: "Manager <A>", stationIds: ["a", "b", "now", "flip"] }],
  activity: [
    activity("a", [
      { date: "2026-09-11", entries: [entry("Van", 150), entry("Van", 150, { countedInTotal: false }), entry("DA", 60), entry("DA", 90, { resourceCategory: "Driver" })] },
      { date: "2026-09-01", entries: [entry("Van", 200)] },
      { date: "2026-08-31", entries: [entry("Van", 9999)] },
      { date: "2026-09-12", entries: [entry("Van", 9999)] }
    ]),
    activity("b", [{ date: "2026-09-10", entries: [entry("Van", 100)] }, { date: "2026-09-11", entries: [entry("DA", 40)] }]),
    activity("now", [{ date: "2026-09-11", entries: [entry("Van", 500)] }]),
    activity("flip", [{ date: "2026-09-11", entries: [entry("Van", 120)] }])
  ]
};

test("program allowlist matches both provider and model", () => {
  for (const [provider, model] of [["AMAZON", "EDSP"], ["AMAZON", "XPT"], ["FLIPKART", "ODH"], ["FLIPKART", "MDH"]]) assert.ok(scope.adHocProgram(station("a", provider, model)));
  for (const [provider, model] of [["AMAZON", "NOW"], ["AMAZON", "AMXL"], ["MEESHO", "EDSP"], ["AMAZON", "ODH"], ["FLIPKART", "XPT"], ["DROPX", "DROPX_HO"], ["AMAZON", ""]]) assert.equal(scope.adHocProgram(station("a", provider, model)), null);
  assert.equal(scope.isAdHocMailStation({ ...station("test"), station_code: "TEST 2" }), false);
  assert.equal(scope.adHocRegionLabel({ region: null, state: "Kerala" }), "KL");
});

test("operations membership scope excludes finance, HR, IT, owner, outside domains and unmapped stations", () => {
  const roles = ["OPERATIONS_CLM", "OPERATIONS_FINMGR", "OPERATIONS_HRM", "OPERATIONS_FSD", "OWNER"].map(code => ({ id: code, code, location_access_mode: "scoped" }));
  const profiles = roles.map(role => ({ id: role.id, email: `${role.id.toLowerCase()}@example.com` }));
  profiles.push({ id: "outside", email: "outside@elsewhere.com" });
  const memberships = roles.map(role => ({ user_id: role.id, role_id: role.id, has_all_location_access: role.id !== "OPERATIONS_CLM", location_scope_ids: ["a", "now"] }));
  memberships.push({ user_id: "outside", role_id: "OPERATIONS_CLM", has_all_location_access: true });
  const recipients = scope.resolveAdHocRecipients(options.stations, memberships, roles, profiles, "example.com", new Set(["OPERATIONS_CLM"]));
  assert.equal(recipients.length, 1);
  assert.deepEqual(recipients[0].stationIds, ["a"]);
});

test("location mailboxes receive only stations whose station email matches", () => {
  const roles = [{ id: "location", code: "OPERATIONS_LOCATION", location_access_mode: "scoped" }];
  const profiles = [{ id: "one", email: " Location@Example.com " }, { id: "two", email: "location@example.com" }];
  const memberships = [{ user_id: "one", role_id: "location", location_scope_ids: [] }, { user_id: "two", role_id: "location", location_scope_ids: ["b"] }];
  const recipients = scope.resolveAdHocRecipients([{ ...station("a"), station_email: "location@example.com" }, station("b")], memberships, roles, profiles, "example.com");
  assert.equal(recipients.length, 1);
  assert.deepEqual(recipients[0].stationIds, ["a"]);
});

test("active Operations Fleet mailbox is eligible but a non-Operations profile is not", () => {
  const roles = [{ id: "fleet", code: "OPERATIONS_FLTM", location_access_mode: "all_locations" }];
  const profiles = [{ id: "ops-fleet", email: "fleet@example.com" }, { id: "outside", email: "outside@example.com" }];
  const memberships = profiles.map(profile => ({ user_id: profile.id, role_id: "fleet", has_all_location_access: true, location_scope_ids: [] }));
  const recipients = scope.resolveAdHocRecipients(options.stations, memberships, roles, profiles, "example.com", new Set(["ops-fleet"]));
  assert.deepEqual(recipients.map(recipient => recipient.email), ["fleet@example.com"]);
});

test("email separates driver and DA, deduplicates linked cashbook entries, and uses report-month boundaries", () => {
  const usage = digest.adHocStationUsage(options.activity[0], options.date);
  assert.deepEqual(usage.day, { Van: { count: 1, amount: 150 }, DA: { count: 1, amount: 60 }, Driver: { count: 1, amount: 90 } });
  assert.deepEqual(usage.mtd.Van, { count: 2, amount: 350 });
  const [message] = digest.buildAdHocMessages(options);
  assert.deepEqual(message.scope.stationIds, ["a", "flip"]);
  assert.equal(message.subject, "Ad hoc usage | September 2026");
  assert.match(message.html, /Previous day: 11 Sept 2026 · MTD: 01 Sept 2026–11 Sept 2026/);
  assert.doesNotMatch(message.html, /Hello |Counts are usage instances|Data checked at/);
  assert.match(message.text, /Ad hoc Driver/);
  assert.match(message.text, /Ad hoc Van — previous day: 2 instances, ₹270.00; MTD: 3 instances, ₹470.00/);
  assert.match(message.text, /Ad hoc DA \/ WM — previous day: 1 instances, ₹60.00; MTD: 1 instances, ₹60.00/);
  assert.match(message.text, /Ad hoc Driver — previous day: 1 instances, ₹90.00; MTD: 1 instances, ₹90.00/);
  assert.match(message.text, /KL REGION[\s\S]*KL total[\s\S]*Ad hoc Van total[\s\S]*Ad hoc DA \/ WM total[\s\S]*Ad hoc Driver total[\s\S]*ODCG REGION[\s\S]*ODCG total/);
  assert.doesNotMatch(message.text, /Station total|Regional total|Overall total/);
  assert.doesNotMatch(message.html, />Program</);
  assert.doesNotMatch(message.text, /9,999|NOW|\nB \|/);
});

test("no message for recipients without a previous-day van; MTD-only and DA-only activity does not qualify", () => {
  assert.deepEqual(digest.buildAdHocMessages({ ...options, recipients: [{ email: "b@example.com", name: "B", stationIds: ["b"] }] }), []);
  assert.deepEqual(digest.buildAdHocMessages({ ...options, activity: [] }), []);
  const [message] = digest.buildAdHocMessages({ ...options, recipients: [{ email: "f@example.com", name: "F", stationIds: ["flip"] }] });
  assert.doesNotMatch(message.text, /Ad hoc Driver|\nA \|/);
  assert.doesNotMatch(message.html, /ODCG region/);
  assert.match(message.text, /Report total/);
});

test("8am IST trigger reports yesterday and retains the previous month on the first", () => {
  const delivery = compile("./portal-digest-delivery.ts", { "server-only": {}, "./timeout-fetch": {}, "./adhoc-digest-scope": scope });
  const control = { state: "enabled", config: { delivery_ready: true, timezone: "Asia/Kolkata", schedule_time: "08:00", day_offset: -1, first_report_date: "2026-09-12" } };
  assert.equal(delivery.dueReportDate(control, new Date("2026-09-13T02:29:59Z")), null);
  assert.equal(delivery.dueReportDate(control, new Date("2026-09-13T02:30:00Z")), "2026-09-12");
  assert.equal(delivery.dueReportDate(control, new Date("2026-09-12T14:00:00Z")), null);
  assert.equal(delivery.dueReportDate(control, new Date("2026-10-01T02:30:00Z")), "2026-09-30");
  assert.equal(delivery.dueReportDate({ ...control, state: "disabled" }, new Date("2026-10-01T02:30:00Z")), null);
});

test("builder stops on incomplete source data and missing operations recipients", async () => {
  const source = { error: "Source failed", stations: [] };
  const module = compile("./adhoc-digest.ts", {
    "./ops-pulse/adhoc-activity": { loadAdHocActivity: async () => source },
    "./adhoc-digest-scope": { ...scope, loadAdHocMailScope: async () => ({ stations: options.stations, recipients: [] }) }
  });
  const control = { company_id: "company", config: {}, subject_template: options.subjectTemplate };
  await assert.rejects(module.buildAdHocDigest({}, control, options.date), /Source failed/);
  source.error = null; source.stations = options.activity.slice(0, 1);
  await assert.rejects(module.buildAdHocDigest({}, control, options.date), /no active operations recipient: A/);
});

test("delivery holds an email when the saved station is removed from the recipient's scope", async () => {
  let sent = false;
  const updates = [];
  const module = compile("./portal-digest-delivery.ts", {
    "server-only": {}, "./timeout-fetch": {},
    "nodemailer": { createTransport: () => { sent = true; throw Error("must not send"); } },
    "./adhoc-digest-scope": { loadAdHocMailScope: async () => ({ recipients: [{ email: "a@example.com", stationIds: ["a"] }] }) }
  });
  const responses = {
    portal_notification_controls: { config: { email_domain: "example.com" } },
    email_notification_settings: { is_enabled: true }, profiles: [{ id: "active" }], portal_digest_threads: null,
    portal_digest_deliveries: { scope_summary: { stationIds: ["removed"] } }
  };
  const db = {
    rpc: async () => ({ data: [{ id: "delivery", event_key: "adhoc_usage_digest", company_id: "company", recipient_email: "a@example.com", report_date: options.date }], error: null }),
    from(table) {
      const query = new Proxy({}, { get(_, key) {
        if (key === "then") return resolve => resolve({ data: responses[table], error: null });
        return (...args) => { if (key === "update") updates.push(args[0]); return query; };
      } });
      return query;
    }
  };
  const result = await module.deliverPortalDigestQueue(db, "ops", { queued: 0, accepted: 0, uncertain: 0, skipped: 0, errors: [] });
  assert.equal(sent, false);
  assert.equal(result.skipped, 1);
  assert.match(updates[0].error, /scope changed/);
});
