import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
let sent, stored;
let root = null;
const db = {
  from(table) {
    const q = {
      select() {
        return q;
      },
      eq() {
        return q;
      },
      maybeSingle() {
        return q;
      },
      insert(v) {
        stored = v;
        return q;
      },
      update(v) {
        stored = v;
        return q;
      },
      then(resolve) {
        return Promise.resolve({
          data:
            table === "ops_audit_programme_settings"
              ? { scheduler_role_ids: ["clm"] }
              : null,
          error: null,
        }).then(resolve);
      },
    };
    return q;
  },
};
const mocks = {
  "./station-audit-report-data": {
    buildStationAuditReport: async () => ({
      pdf: Buffer.from("pdf-fixture"),
      data: {
        photos: [],
        type: "Virtual COD",
        auditor: "Auditor A",
        summary: "Locker requires repair",
        expectedCash: 2500,
        actualCash: 2000,
        cashCounts: [{ denomination: 500, count: 4, amount: 2000 }],
        checks: [
          {
            section: "COD",
            label: "Locker",
            outcome: "Not compliant",
            remarks: "Repair <script>",
            nonCompliant: true,
          },
        ],
        actions: [
          {
            title: "Repair locker",
            status: "open",
            action: "Replace lock",
            owner: "Manager A",
            dueAt: "2026-10-12T04:30:00Z",
          },
        ],
      },
    }),
  },
  "./station-audit-thread": {
    acquireStationAuditThread: async () => ({
      subject: "QLDA · Station audit updates",
      messageId: root ? "next-message" : "root-message",
      inReplyTo: root || undefined,
      references: root ? [root] : undefined,
      finish: async (id) => {
        stored = { root_message_id: root || id };
        root = id;
      },
      release: async () => {},
    }),
  },
  "server-only": {},
  "node:crypto": { randomUUID: () => "message-id" },
  "@/lib/supabase-admin": { supabaseAdmin: db },
  "@/lib/email": {
    sendEmail: async (v) => {
      sent = v;
      return { messageId: v.messageId };
    },
  },
  "./station-audit-planning": { auditDay: () => "2026-10-01" },
  "./station-audit-recipients": {
    resolveStationAuditRecipients: async (company, station, to, cc) => {
      assert.equal(company, "company");
      assert.equal(station.id, "station");
      assert.deepEqual(to, ["station_email"]);
      assert.deepEqual(cc, ["cluster_manager_email"]);
      return {
        to: station.station_email ? [station.station_email] : [],
        cc: station.station_email ? ["manager@example.test"] : [],
      };
    },
  },
};
const mod = { exports: {} };
new Function(
  "require",
  "module",
  "exports",
  ts.transpileModule(
    fs.readFileSync("src/lib/ops-pulse/station-audit-email.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
)(
  (id) => {
    assert.ok(id in mocks, id);
    return mocks[id];
  },
  mod,
  mod.exports,
);
const input = {
  companyId: "company",
  type: {
    id: "type",
    name: "Virtual COD",
    recipient_rules: ["station_email"],
    cc_rules: ["cluster_manager_email"],
    email_body_template: "Cash review",
  },
  station: {
    id: "station",
    station_code: "QLDA",
    station_email: "station@example.test",
    cluster_manager_email: null,
  },
  audit: {
    id: "audit",
    audit_number: "AUD-1",
    scheduled_for: "2026-09-30T20:00Z",
    station_response_status: "requested",
    cash_variance_amount: -500,
    cash_variance_reason: "Pending DA remittance <review>",
    manager_summary: "Recovery action remains open <review>",
    response_due_at: "2026-10-02T12:00Z",
  },
  openActions: 2,
};
await mod.exports.sendStationAuditCompletedEmail(input);
assert.deepEqual(sent.to, ["station@example.test"]);
assert.deepEqual(sent.cc, ["manager@example.test"]);
assert.match(sent.html, /Station response required/);
assert.match(sent.html, /Open OpsPulse &amp; respond/);
assert.match(
  sent.html,
  /https:\/\/ops.dropxlogistics.com\/audits\?audit=audit/,
);
assert.equal(sent.attachments[0].contentType, "application/pdf");
assert.equal(stored.root_message_id, sent.messageId);
assert.equal(sent.subject, "QLDA · Station audit updates");
assert.match(sent.html, /Major findings/);
assert.match(sent.html, /Manager A/);
assert.match(sent.html, /Due \/ ETA/);
assert.match(sent.html, /Repair &lt;script&gt;/);
assert.match(sent.body, /Locker requires repair/);
assert.match(sent.body, /12 Oct 2026/);
assert.match(sent.html, /Expected cash · ERP/);
assert.match(sent.html, /Actual cash · counted/);
assert.match(sent.html, /₹2,500.00/);
assert.match(sent.html, /Cash shortage of ₹500.00/);
assert.match(sent.body, /₹500.00 × 4 = ₹2,000.00/);
assert.match(sent.html, /Denomination total/);
assert.match(sent.html, /Recovery action remains open &lt;review&gt;/);
assert.match(sent.html, /Pending DA remittance &lt;review&gt;/);
const cash = mod.exports.auditCashDetails;
assert.match(
  cash({ system_cash_amount: 0, physical_cash_amount: 0 }).plain,
  /Cash matched/,
);
assert.match(
  cash({ system_cash_amount: null, physical_cash_amount: 0 }).plain,
  /reconciliation incomplete/,
);
assert.doesNotMatch(
  cash({ system_cash_amount: null, physical_cash_amount: 0 }).plain,
  /Cash matched/,
);
assert.match(
  cash({ system_cash_amount: 100, physical_cash_amount: 150 }).plain,
  /Excess cash of ₹50.00/,
);
assert.match(
  cash(
    { system_cash_amount: 100, physical_cash_amount: 100 },
    { cashCounts: [{ denomination: 50, count: 1, amount: 50 }] },
  ).html,
  /denomination total does not match/,
);
assert.match(
  cash(
    { system_cash_amount: 100, physical_cash_amount: 100 },
    { cashCounts: [] },
  ).plain,
  /No denomination breakdown recorded/,
);
const details = mod.exports.auditUpdateDetails(input.audit, {
  checks: Array.from({ length: 12 }, (_, i) => ({
    section: "COD",
    label: `Finding ${i + 1}`,
    outcome: "Pass",
    remarks: `Observation ${i + 1}`,
    nonCompliant: false,
  })),
  actions: [],
  summary: "Audit review",
});
assert.match(
  details.html,
  /Finding 12/,
  "Every recorded observation is included, even for compliant checks",
);
await mod.exports.sendStationAuditCompletedEmail({
  ...input,
  audit: { ...input.audit, station_response_status: "not_requested" },
});
assert.match(sent.html, /View audit report/);
assert.equal(sent.inReplyTo, "root-message");
assert.deepEqual(sent.references, ["root-message"]);
await assert.rejects(
  mod.exports.sendStationAuditCompletedEmail({
    ...input,
    station: { ...input.station, station_email: null },
  }),
  /No audit recipient/,
);
console.log(
  "Audit mail tests passed: scoped cluster recipients, deduplication, response deep link, timezone, report CTA and real email thread root. No external email sent.",
);
