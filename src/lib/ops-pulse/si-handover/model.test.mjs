import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOCK_OUT_MODES,
  currentShift,
  defaultSettings,
  escalationLevel,
  nextShift,
  normalizeSettings,
  progress,
  shouldBlockAttendanceOutPunch,
  validateAnswersForSubmit,
  validateSettings,
} from "./model.ts";
import { defaultSiTemplate } from "./template.ts";

test("default template has 33 tasks across 6 sections", () => {
  const t = defaultSiTemplate();
  assert.equal(t.sections.length, 6);
  assert.equal(
    t.sections.reduce((n, s) => n + s.tasks.length, 0),
    33,
  );
});

test("clock-out mode is configurable and defaults to ops_only", () => {
  assert.equal(normalizeSettings({}).clockOutMode, "ops_only");
  assert.equal(normalizeSettings({ clockOutMode: "hard_block" }).clockOutMode, "hard_block");
  assert.equal(normalizeSettings({ clockOutMode: "nope" }).clockOutMode, "ops_only");
  assert.equal(shouldBlockAttendanceOutPunch(defaultSettings()), false);
  assert.equal(
    shouldBlockAttendanceOutPunch(defaultSettings({ clockOutMode: "hard_block" })),
    true,
  );
  assert.ok(CLOCK_OUT_MODES.some((m) => m.value === "hard_block"));
});

test("owner with page write can fill even when siRoles allowlist excludes their role", async () => {
  const { canFill, canDeleteDraft, taskUnlocked } = await import("./model.ts");
  const actor = {
    userId: "abdul",
    displayName: "Abdul",
    isMasterOwner: false,
    effectiveRoleIds: ["other-role"],
    hasAllLocationAccess: true,
    locationScopeIds: [],
    permissions: { si_handover: { canView: true, canAdd: true, canEdit: true } },
  };
  const settings = defaultSettings({ siRoles: ["sic-role-only"] });
  const row = {
    id: "c1",
    location_id: "s1",
    status: "open",
    outgoing_user_id: "abdul",
    submitted_at: null,
    deleted_at: null,
  };
  assert.equal(canFill(actor, settings, row), true);
  assert.equal(canDeleteDraft(actor, settings, row), true);
  assert.equal(taskUnlocked({ when: "shift_start_mid" }, Date.now(), Date.now(), "start").unlocked, true);
});

test("validateSettings rejects inverted escalation windows", () => {
  assert.throws(
    () =>
      validateSettings(
        defaultSettings({
          escalateStoreMinutes: 60,
          escalateClusterMinutes: 30,
        }),
      ),
    /Cluster escalation/,
  );
});

test("currentShift and nextShift follow 6/14/22 IST windows", () => {
  // 2026-10-22 07:30 IST
  const morning = currentShift(new Date("2026-10-22T02:00:00.000Z"));
  assert.equal(morning.shiftDate, "2026-10-22");
  assert.equal(morning.shiftSlot, "06:00");
  const aft = nextShift(morning.shiftDate, morning.shiftSlot);
  assert.deepEqual(aft, {
    shiftDate: "2026-10-22",
    shiftSlot: "14:00",
    startMs: Date.parse("2026-10-22T14:00:00+05:30"),
  });
  const night = nextShift("2026-10-22", "22:00");
  assert.equal(night.shiftDate, "2026-10-23");
  assert.equal(night.shiftSlot, "06:00");
  // Before 06:00 IST stays on previous night shift
  const early = currentShift(new Date("2026-10-22T00:00:00.000Z")); // 05:30 IST
  assert.equal(early.shiftSlot, "22:00");
  assert.equal(early.shiftDate, "2026-10-21");
});

test("escalation levels use master thresholds", () => {
  const s = defaultSettings({
    escalateStoreMinutes: 30,
    escalateClusterMinutes: 60,
  });
  const submitted = new Date("2026-10-22T08:00:00+05:30").toISOString();
  assert.equal(
    escalationLevel(submitted, s, Date.parse("2026-10-22T08:20:00+05:30")),
    "none",
  );
  assert.equal(
    escalationLevel(submitted, s, Date.parse("2026-10-22T08:35:00+05:30")),
    "store",
  );
  assert.equal(
    escalationLevel(submitted, s, Date.parse("2026-10-22T09:10:00+05:30")),
    "cluster",
  );
});

test("submit validation requires mandatory answers, No reasons, and timed proofs", () => {
  const template = defaultSiTemplate();
  const settings = defaultSettings();
  const row = {
    id: "c1",
    template,
    answers: {},
  };
  const answers = {};
  for (const task of template.sections.flatMap((s) => s.tasks)) {
    if (task.id === "E3" || task.id === "E4") continue; // hyderabad / disposal optional here
    if (task.answerType === "text") {
      answers[task.id] = {
        outcome: "",
        numbers: {},
        text: "Issue A · owner SI",
        informed: "",
      };
      continue;
    }
    if (task.answerType === "number" || task.answerType === "number_x4") {
      const numbers = Object.fromEntries(
        task.numberFields.map((f) => [f.key, "1"]),
      );
      answers[task.id] = { outcome: "yes", numbers, text: "", informed: "" };
      continue;
    }
    answers[task.id] = {
      outcome: "yes",
      numbers: Object.fromEntries(task.numberFields.map((f) => [f.key, "1"])),
      text: "",
      informed: "",
    };
  }
  answers.E4 = { outcome: "na", numbers: {}, text: "No disposal", informed: "" };
  const proofs = template.sections
    .flatMap((s) => s.tasks)
    .filter((t) => t.proof.kind === "photo" || t.proof.kind === "screenshot")
    .filter((t) => t.id !== "E3" && !(t.id === "E4"))
    .flatMap((t) =>
      Array.from({ length: t.proof.min }, (_, i) => ({
        id: `${t.id}-${i}`,
        checklist_id: "c1",
        task_id: t.id,
        ready: true,
        captured_at: new Date().toISOString(),
      })),
    );
  assert.doesNotThrow(() =>
    validateAnswersForSubmit(row, answers, proofs, { city: "Chennai", settings }),
  );
  answers.A1.outcome = "no";
  answers.A1.text = "";
  assert.throws(
    () =>
      validateAnswersForSubmit(row, answers, proofs, {
        city: "Chennai",
        settings,
      }),
    /Reason required/,
  );
  const p = progress(
    { template, answers: { A1: answers.A1 } },
    { city: "Chennai", settings },
  );
  assert.ok(p.total >= 1);
});
