/** Shift Incharge handover checklist — versioned template + state machine. */

export type TaskWhen =
  | "shift_start"
  | "mid_shift"
  | "shift_end"
  | "every_2hrs"
  | "each_vehicle"
  | "when_disposal"
  | "shift_start_mid"
  | "mid_shift_end";

export type AnswerType =
  | "yes_no"
  | "yes_no_na"
  | "number"
  | "number_x4"
  | "text";

export type ProofKind = "none" | "photo" | "screenshot" | "optional";
export type ProofRule = { kind: ProofKind; min: number; max: number };
export type NoRequires = "reason" | "informed" | "both";
export type MandatoryRule = "yes" | "hyderabad" | "if_disposal";

export type NumberField = { key: string; label: string };

export type Task = {
  id: string;
  label: string;
  guidance: string;
  when: TaskWhen;
  answerType: AnswerType;
  numberFields: NumberField[];
  proof: ProofRule;
  noRequires: NoRequires;
  mandatory: MandatoryRule;
  linksTo: string;
};

export type Section = {
  id: string;
  name: string;
  guidance: string;
  tasks: Task[];
};

export type Template = {
  name: string;
  description: string;
  sections: Section[];
};

/** How outgoing SI leaving is gated until incoming accepts. */
export type ClockOutMode = "ops_only" | "hard_block" | "soft_warn";

export const CLOCK_OUT_MODES: {
  value: ClockOutMode;
  label: string;
  detail: string;
}[] = [
  {
    value: "ops_only",
    label: "Ops Pulse only",
    detail:
      "End Shift stays Pending acceptance with banners and escalation. Connect attendance punch is not blocked.",
  },
  {
    value: "hard_block",
    label: "Hard block attendance out-punch",
    detail:
      "Prevent Connect out-punch for the outgoing Shift Incharge until handover is Accepted.",
  },
  {
    value: "soft_warn",
    label: "Soft warn only",
    detail:
      "Allow End Shift and attendance out-punch with a clear warning when handover is not Accepted.",
  },
];

export type Settings = {
  managerRoles: string[];
  /** Roles that may fill and submit as Shift Incharge. */
  siRoles: string[];
  modelIds: string[];
  /** Cities where hyderabad-mandatory tasks apply (case-insensitive substring match). */
  hyderabadCityMatch: string[];
  clockOutMode: ClockOutMode;
  escalateStoreMinutes: number;
  escalateClusterMinutes: number;
  shiftSlots: string[];
};

export type Master = {
  company_id: string;
  version: number;
  template: Template;
  settings: Settings;
  updated_at: string;
};

export type Outcome = "" | "yes" | "no" | "na";

export type TaskAnswer = {
  outcome: Outcome;
  numbers: Record<string, string>;
  text: string;
  informed: string;
  answeredAt?: string;
};

export type Rejection = {
  taskIds: string[];
  reason: string;
  by: string;
  byName: string;
  at: string;
};

export type ChecklistEvent = {
  at: string;
  actor: string;
  actorName: string;
  kind: string;
  note: string;
};

export type ChecklistStatus =
  | "open"
  | "submitted"
  | "rejected"
  | "accepted"
  | "cancelled";

export type ShiftSlot = "06:00" | "14:00" | "22:00";

export type SiChecklist = {
  id: string;
  company_id: string;
  location_id: string;
  store_code: string;
  store_name: string;
  shift_date: string;
  shift_slot: ShiftSlot;
  status: ChecklistStatus;
  template: Template;
  template_version: number;
  answers: Record<string, TaskAnswer>;
  rejection: Rejection | null;
  open_issues: string;
  events: ChecklistEvent[];
  version: number;
  outgoing_user_id: string;
  outgoing_name: string;
  incoming_user_id: string | null;
  incoming_name: string | null;
  started_at: string;
  submitted_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  accepted_by: string | null;
  rejected_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type Evidence = {
  id: string;
  checklist_id: string;
  task_id: string;
  file_name: string;
  content_type: string;
  size: number;
  path: string;
  ready: boolean;
  captured_at: string;
  latitude: number | null;
  longitude: number | null;
  uploaded_by: string;
  created_at: string;
};

export type Actor = {
  userId: string;
  displayName: string;
  isMasterOwner: boolean;
  effectiveRoleIds: string[];
  hasAllLocationAccess: boolean;
  locationScopeIds: string[];
  readOnly?: boolean;
  permissions: Record<
    string,
    { canView?: boolean; canAdd?: boolean; canEdit?: boolean } | undefined
  >;
};

export const DEFAULT_SHIFT_SLOTS: ShiftSlot[] = ["06:00", "14:00", "22:00"];

export function defaultSettings(partial?: Partial<Settings>): Settings {
  return {
    managerRoles: [],
    siRoles: [],
    modelIds: [],
    hyderabadCityMatch: ["hyderabad", "hyd"],
    clockOutMode: "ops_only",
    escalateStoreMinutes: 30,
    escalateClusterMinutes: 60,
    shiftSlots: [...DEFAULT_SHIFT_SLOTS],
    ...partial,
  };
}

export function normalizeSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<Settings>;
  const mode = CLOCK_OUT_MODES.some((m) => m.value === s.clockOutMode)
    ? (s.clockOutMode as ClockOutMode)
    : "ops_only";
  const slots = Array.isArray(s.shiftSlots)
    ? s.shiftSlots.filter((x): x is string => typeof x === "string")
    : [...DEFAULT_SHIFT_SLOTS];
  return defaultSettings({
    managerRoles: Array.isArray(s.managerRoles)
      ? s.managerRoles.filter((x): x is string => typeof x === "string")
      : [],
    siRoles: Array.isArray(s.siRoles)
      ? s.siRoles.filter((x): x is string => typeof x === "string")
      : [],
    modelIds: Array.isArray(s.modelIds)
      ? s.modelIds.filter((x): x is string => typeof x === "string")
      : [],
    hyderabadCityMatch: Array.isArray(s.hyderabadCityMatch)
      ? s.hyderabadCityMatch.filter((x): x is string => typeof x === "string")
      : ["hyderabad", "hyd"],
    clockOutMode: mode,
    escalateStoreMinutes:
      Number.isFinite(s.escalateStoreMinutes) &&
      Number(s.escalateStoreMinutes) > 0
        ? Number(s.escalateStoreMinutes)
        : 30,
    escalateClusterMinutes:
      Number.isFinite(s.escalateClusterMinutes) &&
      Number(s.escalateClusterMinutes) > 0
        ? Number(s.escalateClusterMinutes)
        : 60,
    shiftSlots: slots.length ? slots : [...DEFAULT_SHIFT_SLOTS],
  });
}

export const tasks = (t: Template) => t.sections.flatMap((s) => s.tasks);

export const emptyAnswer = (): TaskAnswer => ({
  outcome: "",
  numbers: {},
  text: "",
  informed: "",
});

export function isManager(a: Actor, s: Settings) {
  return (
    a.isMasterOwner ||
    a.effectiveRoleIds.some((id) => s.managerRoles.includes(id))
  );
}

export function isSi(a: Actor, s: Settings) {
  if (a.isMasterOwner) return true;
  if (!s.siRoles.length) {
    return Boolean(
      a.permissions.si_handover?.canAdd || a.permissions.si_handover?.canEdit,
    );
  }
  return a.effectiveRoleIds.some((id) => s.siRoles.includes(id));
}

export function inScope(a: Actor, locationId: string) {
  return a.hasAllLocationAccess || a.locationScopeIds.includes(locationId);
}

export function canRead(a: Actor, s: Settings, row: SiChecklist) {
  return (
    !row.deleted_at &&
    inScope(a, row.location_id) &&
    Boolean(a.permissions.si_handover?.canView) &&
    (isManager(a, s) ||
      isSi(a, s) ||
      a.userId === row.outgoing_user_id ||
      a.userId === row.incoming_user_id)
  );
}

export function canFill(a: Actor, s: Settings, row: SiChecklist) {
  return (
    !a.readOnly &&
    canRead(a, s, row) &&
    isSi(a, s) &&
    ["open", "rejected"].includes(row.status) &&
    a.userId === row.outgoing_user_id &&
    Boolean(a.permissions.si_handover?.canAdd || a.permissions.si_handover?.canEdit)
  );
}

export function canAccept(a: Actor, s: Settings, row: SiChecklist) {
  return (
    !a.readOnly &&
    canRead(a, s, row) &&
    isSi(a, s) &&
    row.status === "submitted" &&
    a.userId !== row.outgoing_user_id &&
    Boolean(a.permissions.si_handover?.canAdd || a.permissions.si_handover?.canEdit)
  );
}

export function canUnlock(a: Actor, s: Settings, row: SiChecklist) {
  return (
    !a.readOnly &&
    isManager(a, s) &&
    inScope(a, row.location_id) &&
    row.status === "accepted" &&
    Boolean(a.permissions.si_handover_master?.canEdit || a.isMasterOwner)
  );
}

/** Whether Connect out-punch should be refused for this outgoing SI. */
export function shouldBlockAttendanceOutPunch(settings: Settings) {
  return normalizeSettings(settings).clockOutMode === "hard_block";
}

export function isHyderabadStore(
  city: string | null | undefined,
  settings: Settings,
) {
  const c = (city || "").toLowerCase();
  return settings.hyderabadCityMatch.some((m) => c.includes(m.toLowerCase()));
}

export function isTaskMandatory(
  task: Task,
  ctx: { city?: string | null; disposalDone: boolean; settings: Settings },
) {
  if (task.mandatory === "yes") return true;
  if (task.mandatory === "hyderabad")
    return isHyderabadStore(ctx.city, ctx.settings);
  if (task.mandatory === "if_disposal") return ctx.disposalDone;
  return false;
}

const START_WHENS: TaskWhen[] = ["shift_start", "shift_start_mid"];
const MID_WHENS: TaskWhen[] = [
  "mid_shift",
  "shift_start_mid",
  "mid_shift_end",
  "every_2hrs",
  "each_vehicle",
];
const END_WHENS: TaskWhen[] = [
  "shift_end",
  "mid_shift_end",
  "when_disposal",
  "every_2hrs",
  "each_vehicle",
];

export type WorkspaceView = "start" | "during" | "handover" | "accept";

export function tasksForView(view: WorkspaceView, template: Template): Task[] {
  const all = tasks(template);
  if (view === "start") return all.filter((t) => START_WHENS.includes(t.when));
  if (view === "during") return all.filter((t) => MID_WHENS.includes(t.when));
  if (view === "handover") return all.filter((t) => END_WHENS.includes(t.when));
  return all;
}

export function taskUnlocked(
  task: Task,
  shiftStartMs: number,
  nowMs = Date.now(),
): { unlocked: boolean; overdue: boolean } {
  const elapsed = nowMs - shiftStartMs;
  if (task.when === "every_2hrs") {
    const unlocked = elapsed >= 0;
    const windows = Math.floor(elapsed / (2 * 60 * 60 * 1000));
    return { unlocked, overdue: unlocked && windows >= 1 && elapsed % (2 * 60 * 60 * 1000) > 15 * 60 * 1000 };
  }
  if (task.when === "mid_shift" || task.when === "shift_start_mid") {
    const mid = 4 * 60 * 60 * 1000;
    return { unlocked: elapsed >= mid * 0.4, overdue: elapsed > mid + 30 * 60 * 1000 };
  }
  if (task.when === "mid_shift_end") {
    return { unlocked: elapsed >= 3 * 60 * 60 * 1000, overdue: false };
  }
  if (task.when === "shift_end" || task.when === "when_disposal") {
    const endSoon = 6 * 60 * 60 * 1000;
    return { unlocked: elapsed >= endSoon * 0.5, overdue: false };
  }
  return { unlocked: true, overdue: false };
}

export function parseShiftSlot(v: string): ShiftSlot {
  if (v === "06:00" || v === "14:00" || v === "22:00") return v;
  throw Error("Shift slot must be 06:00, 14:00 or 22:00.");
}

/** Current IST shift window for Amazon Now stores. */
export function currentShift(
  now = new Date(),
  slots: string[] = DEFAULT_SHIFT_SLOTS,
): { shiftDate: string; shiftSlot: ShiftSlot; startMs: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  const ordered = (slots.length ? slots : DEFAULT_SHIFT_SLOTS)
    .map((s) => {
      const [h, m] = s.split(":").map(Number);
      return { slot: s as ShiftSlot, minutes: h * 60 + (m || 0) };
    })
    .sort((a, b) => a.minutes - b.minutes);
  let chosen = ordered[ordered.length - 1]!;
  let shiftDate = date;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (minutes >= ordered[i]!.minutes) {
      chosen = ordered[i]!;
      break;
    }
  }
  if (minutes < ordered[0]!.minutes) {
    // Before first slot: still on previous day's last shift.
    const d = new Date(`${date}T12:00:00+05:30`);
    d.setDate(d.getDate() - 1);
    shiftDate = d.toISOString().slice(0, 10);
    chosen = ordered[ordered.length - 1]!;
  }
  const startMs = Date.parse(`${shiftDate}T${chosen.slot}:00+05:30`);
  return { shiftDate, shiftSlot: chosen.slot, startMs };
}

export function nextShift(
  shiftDate: string,
  shiftSlot: ShiftSlot,
  slots: string[] = DEFAULT_SHIFT_SLOTS,
): { shiftDate: string; shiftSlot: ShiftSlot; startMs: number } {
  const ordered = (slots.length ? slots : DEFAULT_SHIFT_SLOTS) as ShiftSlot[];
  const i = ordered.indexOf(shiftSlot);
  if (i < 0) throw Error("Unknown shift slot.");
  if (i < ordered.length - 1) {
    const next = ordered[i + 1]!;
    return {
      shiftDate,
      shiftSlot: next,
      startMs: Date.parse(`${shiftDate}T${next}:00+05:30`),
    };
  }
  const d = new Date(`${shiftDate}T12:00:00+05:30`);
  d.setDate(d.getDate() + 1);
  const nextDate = d.toISOString().slice(0, 10);
  const next = ordered[0]!;
  return {
    shiftDate: nextDate,
    shiftSlot: next,
    startMs: Date.parse(`${nextDate}T${next}:00+05:30`),
  };
}

export function disposalDone(answers: Record<string, TaskAnswer>) {
  const e4 = answers.E4;
  return Boolean(e4 && e4.outcome === "yes");
}

export function requiredProofCount(task: Task, answer: TaskAnswer) {
  if (task.proof.kind === "none") return 0;
  if (task.proof.kind === "optional") return 0;
  if (answer.outcome === "na") return 0;
  if (!answer.outcome && task.answerType === "text") return task.proof.min;
  if (!answer.outcome) return 0;
  return task.proof.min;
}

export function validateAnswersForSubmit(
  row: SiChecklist,
  answers: Record<string, TaskAnswer>,
  proofs: Evidence[],
  ctx: { city?: string | null; settings: Settings },
) {
  const done = disposalDone(answers);
  for (const task of tasks(row.template)) {
    const mandatory = isTaskMandatory(task, {
      city: ctx.city,
      disposalDone: done,
      settings: ctx.settings,
    });
    const a = answers[task.id] || emptyAnswer();
    if (task.answerType === "text") {
      if (mandatory && !a.text.trim())
        throw Error(`Complete: ${task.label}`);
      continue;
    }
    if (task.answerType === "number" || task.answerType === "number_x4") {
      for (const f of task.numberFields) {
        const v = a.numbers[f.key];
        if (mandatory && (v === undefined || v === null || String(v).trim() === ""))
          throw Error(`Enter ${f.label}: ${task.label}`);
      }
    } else if (!a.outcome) {
      if (mandatory) throw Error(`Answer: ${task.label}`);
      continue;
    }
    if (task.answerType === "yes_no" && !["yes", "no"].includes(a.outcome))
      throw Error(`Choose Yes or No: ${task.label}`);
    if (
      task.answerType === "yes_no_na" &&
      !["yes", "no", "na"].includes(a.outcome)
    )
      throw Error(`Choose Yes, No or N/A: ${task.label}`);
    if (task.answerType === "yes_no" || task.answerType === "yes_no_na") {
      for (const f of task.numberFields) {
        if (a.outcome === "yes" || a.outcome === "no") {
          const v = a.numbers[f.key];
          if (v === undefined || String(v).trim() === "")
            throw Error(`Enter ${f.label}: ${task.label}`);
        }
      }
    }
    if (a.outcome === "no") {
      if (
        (task.noRequires === "reason" || task.noRequires === "both") &&
        !a.text.trim()
      )
        throw Error(`Reason required when No: ${task.label}`);
      if (
        (task.noRequires === "informed" || task.noRequires === "both") &&
        !a.informed.trim()
      )
        throw Error(`Who was informed?: ${task.label}`);
    }
    if (a.outcome === "na" && !a.text.trim())
      throw Error(`Explain N/A: ${task.label}`);
    const count = proofs.filter(
      (p) => p.ready && p.checklist_id === row.id && p.task_id === task.id,
    ).length;
    const need = requiredProofCount(task, a);
    if (count < need || count > task.proof.max)
      throw Error(
        `Proof for ${task.label}: need ${need}–${task.proof.max} file(s) with timestamp.`,
      );
  }
  const f2 = answers.F2 || emptyAnswer();
  if (!f2.text.trim()) throw Error("List open issues for the incoming SI (F2).");
}

export function validateSettings(s: Settings) {
  const n = normalizeSettings(s);
  if (!CLOCK_OUT_MODES.some((m) => m.value === n.clockOutMode))
    throw Error("Choose a valid clock-out enforcement mode.");
  if (n.escalateStoreMinutes < 5 || n.escalateStoreMinutes > 24 * 60)
    throw Error("Store escalation must be between 5 and 1440 minutes.");
  if (
    n.escalateClusterMinutes < n.escalateStoreMinutes ||
    n.escalateClusterMinutes > 48 * 60
  )
    throw Error(
      "Cluster escalation must be at or above the store threshold and under 48 hours.",
    );
  if (!n.shiftSlots.length) throw Error("Configure at least one shift slot.");
  return n;
}

export function escalationLevel(
  submittedAt: string | null,
  settings: Settings,
  now = Date.now(),
): "none" | "store" | "cluster" {
  if (!submittedAt) return "none";
  const mins = (now - Date.parse(submittedAt)) / 60000;
  if (mins >= settings.escalateClusterMinutes) return "cluster";
  if (mins >= settings.escalateStoreMinutes) return "store";
  return "none";
}

export const statusLabels: Record<ChecklistStatus, string> = {
  open: "In progress",
  submitted: "Awaiting acceptance",
  rejected: "Returned for fix",
  accepted: "Accepted",
  cancelled: "Cancelled",
};

export function progress(
  row: Pick<SiChecklist, "template" | "answers">,
  ctx: { city?: string | null; settings: Settings },
) {
  const done = disposalDone(row.answers);
  let total = 0;
  let answered = 0;
  for (const task of tasks(row.template)) {
    if (
      !isTaskMandatory(task, {
        city: ctx.city,
        disposalDone: done,
        settings: ctx.settings,
      })
    )
      continue;
    total += 1;
    const a = row.answers[task.id];
    const filled =
      task.answerType === "text"
        ? Boolean(a?.text?.trim())
        : task.answerType === "number" || task.answerType === "number_x4"
          ? task.numberFields.every((f) => String(a?.numbers?.[f.key] ?? "").trim())
          : Boolean(a?.outcome);
    if (filled) answered += 1;
  }
  return { total, answered, pct: total ? Math.round((100 * answered) / total) : 0 };
}
