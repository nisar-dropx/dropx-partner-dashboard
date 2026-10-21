import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function compile(path, mocks = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function("require", "exports", "module", code)(
    (name) => {
      if (name in mocks) return mocks[name];
      throw new Error(name);
    },
    module.exports,
    module,
  );
  return module.exports;
}

const render = compile("./loss-recovery-action-digest-render.ts");

test("empty action set produces no digest messages (builder short-circuits)", async () => {
  const digest = compile("./loss-recovery-action-digest.ts", {
    "./portal-digest-delivery": {},
    "@/lib/people-operational-hierarchy": { loadPeopleOperationalHierarchy: async () => ({ byLocation: new Map(), error: null }) },
    "./ops-pulse/salary-hold-policy": { holdApprovers: () => ({ personIds: [] }) },
    "./approval-covers": { loadActiveApprovalCovers: async () => [] },
    "./loss-recovery-action-digest-render": render,
  });
  const db = {
    rpc: async () => ({ data: [], error: null }),
    from: () => {
      throw new Error("should not load owners when there are no actions");
    },
  };
  const result = await digest.buildLossRecoveryActionDigest(
    db,
    { company_id: "c", portal: "ops", event_key: "loss_recovery_action_digest", state: "disabled", paused_until: null, subject_template: null, config: {} },
    "2026-10-22",
  );
  assert.deepEqual(result.messages, []);
  assert.ok(result.checkedAt);
});

test("sample digest HTML names the day, cases and open Losses CTA", () => {
  const rows = [
    {
      station_code: "BLR1",
      month: "2026-09",
      case_key: "TID123456789",
      report: "nl",
      amount: 1250.5,
      lifecycle_status: "cluster_validation_pending",
      action_key: "cluster_validate",
      action_label: "Cluster validation",
      owner_role: "cluster",
      age_days: 3,
      due_month: null,
      blocker: null,
      deep_link: "/team-ops/losses/nl?month=2026-09&case=TID123456789",
    },
    {
      station_code: "BLR1",
      month: "2026-09",
      case_key: "slp:AMZ987",
      report: "slp",
      amount: 800,
      lifecycle_status: "slp_final_confirmation_pending",
      action_key: "slp_approve",
      action_label: "SLP final confirmation",
      owner_role: "slp",
      age_days: 1,
      due_month: "2026-10",
      blocker: "Awaiting SLP",
      deep_link: "/team-ops/losses/nl?month=2026-09&case=slp%3AAMZ987",
    },
  ];
  const subject = render.lossRecoveryDigestSubject("DropX · Loss recovery actions · {{date}}", "2026-10-22");
  assert.equal(subject, "DropX · Loss recovery actions · 2026-10-22");
  const { html, text } = render.renderLossRecoveryDigestEmail({
    date: "2026-10-22",
    recipientName: "Cluster Manager",
    rows,
  });
  assert.match(html, /Loss recovery actions/);
  assert.match(html, /2026-10-22 · 2 open/);
  assert.match(html, /TID123456789/);
  assert.match(html, /slp:AMZ987/);
  assert.match(html, /₹1,250\.50/);
  assert.match(html, /Open Losses/);
  assert.match(text, /Cluster validation/);
  assert.match(text, /Awaiting SLP/);
  assert.doesNotMatch(html, /<script/i);
});

test("cron registration and disabled seed stay wired for dry-run day", () => {
  const cron = readFileSync(new URL("../app/api/cron/portal-notifications/route.ts", import.meta.url), "utf8");
  const seed = readFileSync(new URL("../../supabase/migrations/20261022121000_loss_recovery_action_digest.sql", import.meta.url), "utf8");
  assert.match(cron, /loss_recovery_action_digest/);
  assert.match(cron, /buildLossRecoveryActionDigest/);
  assert.match(seed, /'disabled'/);
  assert.match(seed, /'delivery_ready', false/);
  assert.match(seed, /\{\{date\}\}/);
});
