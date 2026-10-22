/** Store Manager / Store In-charge daily checklist — submit-only (no accept). */

import {
  emptyAnswer,
  normalizeAnswer,
  proofMimeAllowed,
  requiredProofCount as siRequiredProofCount,
  type AnswerType,
  type Evidence as SiEvidence,
  type NoRequires,
  type NumberField,
  type Outcome,
  type ProofRule,
  type TaskAnswer,
} from "@/lib/ops-pulse/si-handover/model";

export type {
  AnswerType,
  NoRequires,
  NumberField,
  Outcome,
  ProofRule,
  TaskAnswer,
};
export { emptyAnswer, normalizeAnswer, proofMimeAllowed };

export type TaskFrequency =
  | "daily"
  | "weekly"
  | "monthly"
  | "when_applicable"
  | "when_disposal";

export type TaskWhen = "start" | "after_d1" | "compliance" | "close";

export type MandatoryRule =
  | "yes"
  | "hyderabad"
  | "if_disposal"
  | "when_applicable"
  | "weekly"
  | "monthly";

export type Task = {
  id: string;
  label: string;
  guidance: string;
  frequency: TaskFrequency;
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

export const STORE_OPS_TEMPLATE_FORMAT = 1;

export type Settings = {
  fillerRoles: string[];
  managerRoles: string[];
  modelIds: string[];
  hyderabadCityMatch: string[];
  templateFormat: number;
};

export type Master = {
  company_id: string;
  version: number;
  template: Template;
  settings: Settings;
  updated_at: string;
};

export type ChecklistStatus = "open" | "submitted" | "cancelled";

export type ChecklistEvent = {
  at: string;
  actor: string;
  actorName: string;
  kind: string;
  note: string;
};

export type StoreOpsChecklist = {
  id: string;
  company_id: string;
  location_id: string;
  store_code: string;
  store_name: string;
  work_date: string;
  status: ChecklistStatus;
  template: Template;
  template_version: number;
  answers: Record<string, TaskAnswer>;
  day_summary: string;
  events: ChecklistEvent[];
  version: number;
  owner_user_id: string;
  owner_name: string;
  started_at: string;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type Evidence = SiEvidence;

export type Actor = {
  userId: string;
  displayName: string;
  isMasterOwner: boolean;
  effectiveRoleIds: string[];
  hasAllLocationAccess: boolean;
  locationScopeIds: string[];
  readOnly: boolean;
  permissions: Record<
    string,
    { canView?: boolean; canAdd?: boolean; canEdit?: boolean }
  >;
};

export type WorkspaceView = "start" | "midday" | "compliance" | "close";

export const statusLabels: Record<ChecklistStatus, string> = {
  open: "In progress",
  submitted: "Submitted",
  cancelled: "Cancelled",
};

export function defaultSettings(): Settings {
  return {
    fillerRoles: [],
    managerRoles: [],
    modelIds: [],
    hyderabadCityMatch: ["hyderabad", "hyd"],
    templateFormat: STORE_OPS_TEMPLATE_FORMAT,
  };
}

export function normalizeSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<Settings>;
  const base = defaultSettings();
  return {
    fillerRoles: Array.isArray(s.fillerRoles)
      ? s.fillerRoles.filter((x): x is string => typeof x === "string")
      : base.fillerRoles,
    managerRoles: Array.isArray(s.managerRoles)
      ? s.managerRoles.filter((x): x is string => typeof x === "string")
      : base.managerRoles,
    modelIds: Array.isArray(s.modelIds)
      ? s.modelIds.filter((x): x is string => typeof x === "string")
      : base.modelIds,
    hyderabadCityMatch: Array.isArray(s.hyderabadCityMatch)
      ? s.hyderabadCityMatch.filter((x): x is string => typeof x === "string")
      : base.hyderabadCityMatch,
    templateFormat: Number.isFinite(Number(s.templateFormat))
      ? Number(s.templateFormat)
      : 0,
  };
}

export const tasks = (t: Template) => t.sections.flatMap((s) => s.tasks);

/** Start/submit requires can_add (SM / Store In-charge). Oversight roles get can_edit only. */
function hasFillPermission(a: Actor) {
  return Boolean(a.permissions.store_ops?.canAdd);
}

function hasAccess(a: Actor) {
  return Boolean(
    a.permissions.store_ops?.canView ||
      a.permissions.store_ops?.canAdd ||
      a.permissions.store_ops?.canEdit,
  );
}

export function isFiller(a: Actor, s: Settings) {
  if (a.isMasterOwner) return true;
  if (!hasFillPermission(a)) return false;
  if (!s.fillerRoles.length) return true;
  return a.effectiveRoleIds.some((id) => s.fillerRoles.includes(id));
}

export function isManager(a: Actor, s: Settings) {
  if (a.isMasterOwner) return true;
  // Empty allowlist = anyone with Store Operations access can oversee / report.
  if (!s.managerRoles.length) return hasAccess(a);
  return a.effectiveRoleIds.some((id) => s.managerRoles.includes(id));
}

export function inScope(a: Actor, locationId: string) {
  return a.hasAllLocationAccess || a.locationScopeIds.includes(locationId);
}

export function canRead(a: Actor, s: Settings, row: StoreOpsChecklist) {
  return (
    hasAccess(a) &&
    inScope(a, row.location_id) &&
    (isFiller(a, s) || isManager(a, s) || a.isMasterOwner)
  );
}

export function canFill(a: Actor, s: Settings, row: StoreOpsChecklist) {
  return (
    !a.readOnly &&
    row.status === "open" &&
    inScope(a, row.location_id) &&
    isFiller(a, s) &&
    (a.isMasterOwner || hasFillPermission(a))
  );
}

/** Whether an answer is complete enough to count the task done (for progress / period skip). */
export function answerLooksComplete(task: Task, a: TaskAnswer | undefined) {
  if (!a) return false;
  if (task.answerType === "text") return Boolean(a.text?.trim());
  if (task.answerType === "number" || task.answerType === "number_x4") {
    return task.numberFields.every((f) =>
      String(a.numbers?.[f.key] ?? "").trim(),
    );
  }
  if (!a.outcome) return false;
  if (task.answerType === "yes_no" && !["yes", "no"].includes(a.outcome))
    return false;
  if (
    task.answerType === "yes_no_na" &&
    !["yes", "no", "na"].includes(a.outcome)
  )
    return false;
  if (
    (task.answerType === "yes_no" || task.answerType === "yes_no_na") &&
    (a.outcome === "yes" || a.outcome === "no")
  ) {
    if (
      !task.numberFields.every((f) => String(a.numbers?.[f.key] ?? "").trim())
    )
      return false;
  }
  if (a.outcome === "no") {
    if (
      (task.noRequires === "reason" || task.noRequires === "both") &&
      !a.text?.trim()
    )
      return false;
  }
  if (a.outcome === "na" && !a.text?.trim()) return false;
  return true;
}

export function isHyderabadStore(city: string | null | undefined, s: Settings) {
  const c = String(city || "").toLowerCase();
  return s.hyderabadCityMatch.some((m) => c.includes(String(m).toLowerCase()));
}

/** Monday (ISO) date string for a work date in IST calendar sense. */
export function weekStartMonday(workDate: string) {
  const d = new Date(`${workDate}T12:00:00+05:30`);
  const day = d.getUTCDay(); // Sun=0 … but we used +05:30 noon so local weekday ≈ IST
  const ist = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const wd = ist.getDay();
  const diff = wd === 0 ? -6 : 1 - wd;
  ist.setDate(ist.getDate() + diff);
  const y = ist.getFullYear();
  const m = String(ist.getMonth() + 1).padStart(2, "0");
  const dd = String(ist.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function monthKey(workDate: string) {
  return workDate.slice(0, 7);
}

export function disposalDone(answers: Record<string, TaskAnswer>) {
  return Boolean(answers.M15 && answers.M15.outcome === "yes");
}

export function isTaskMandatory(
  task: Task,
  ctx: {
    city?: string | null;
    disposalDone: boolean;
    settings: Settings;
    weeklyDone: boolean;
    monthlyDone: boolean;
  },
) {
  if (task.mandatory === "yes") return true;
  if (task.mandatory === "hyderabad")
    return isHyderabadStore(ctx.city, ctx.settings);
  if (task.mandatory === "if_disposal") return ctx.disposalDone;
  if (task.mandatory === "when_applicable") return false; // N/A allowed
  if (task.mandatory === "weekly") return !ctx.weeklyDone;
  if (task.mandatory === "monthly") return !ctx.monthlyDone;
  return false;
}

export function tasksForView(view: WorkspaceView, template: Template): Task[] {
  const all = tasks(template);
  if (view === "start") return all.filter((t) => t.when === "start");
  if (view === "midday") return all.filter((t) => t.when === "after_d1");
  if (view === "compliance") return all.filter((t) => t.when === "compliance");
  if (view === "close") return all.filter((t) => t.when === "close");
  return all;
}

export function requiredProofCount(task: Task, answer: TaskAnswer) {
  return siRequiredProofCount(
    {
      id: task.id,
      label: task.label,
      guidance: task.guidance,
      when: "shift_start",
      answerType: task.answerType,
      numberFields: task.numberFields,
      proof: task.proof,
      noRequires: task.noRequires,
      mandatory: "yes",
      linksTo: task.linksTo,
    },
    answer,
  );
}

export function validateForSubmit(
  row: StoreOpsChecklist,
  answers: Record<string, TaskAnswer>,
  proofs: Evidence[],
  ctx: {
    city?: string | null;
    settings: Settings;
    weeklyDoneIds: Set<string>;
    monthlyDoneIds: Set<string>;
  },
) {
  const done = disposalDone(answers);
  for (const task of tasks(row.template)) {
    const mandatory = isTaskMandatory(task, {
      city: ctx.city,
      disposalDone: done,
      settings: ctx.settings,
      weeklyDone: ctx.weeklyDoneIds.has(task.id),
      monthlyDone: ctx.monthlyDoneIds.has(task.id),
    });
    if (
      (task.frequency === "weekly" && ctx.weeklyDoneIds.has(task.id)) ||
      (task.frequency === "monthly" && ctx.monthlyDoneIds.has(task.id))
    ) {
      continue;
    }
    const a = answers[task.id] || emptyAnswer();
    if (task.answerType === "text") {
      if (mandatory && !a.text.trim())
        throw Error(`Complete: ${task.label}`);
      continue;
    }
    if (task.answerType === "number" || task.answerType === "number_x4") {
      for (const f of task.numberFields) {
        const v = a.numbers[f.key];
        if (mandatory && (v === undefined || String(v).trim() === ""))
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
    }
    if (a.outcome === "na" && !a.text.trim())
      throw Error(`Explain N/A: ${task.label}`);
    const count = proofs.filter(
      (p) => p.ready && p.checklist_id === row.id && p.task_id === task.id,
    ).length;
    const need = requiredProofCount(task, a);
    if (count < need || count > task.proof.max)
      throw Error(
        `Proof for ${task.label}: need ${need}–${task.proof.max} file(s).`,
      );
  }
  const m19 = answers.M19 || emptyAnswer();
  if (!m19.text.trim())
    throw Error("Day summary to City Manager is required (M19).");
}

export function progress(
  row: Pick<StoreOpsChecklist, "template" | "answers">,
  ctx: {
    city?: string | null;
    settings: Settings;
    weeklyDoneIds?: Set<string>;
    monthlyDoneIds?: Set<string>;
  },
) {
  const done = disposalDone(row.answers);
  const weekly = ctx.weeklyDoneIds || new Set<string>();
  const monthly = ctx.monthlyDoneIds || new Set<string>();
  let total = 0;
  let answered = 0;
  for (const task of tasks(row.template)) {
    if (task.frequency === "weekly" && weekly.has(task.id)) continue;
    if (task.frequency === "monthly" && monthly.has(task.id)) continue;
    const mandatory = isTaskMandatory(task, {
      city: ctx.city,
      disposalDone: done,
      settings: ctx.settings,
      weeklyDone: weekly.has(task.id),
      monthlyDone: monthly.has(task.id),
    });
    if (!mandatory) continue;
    total += 1;
    if (answerLooksComplete(task, row.answers[task.id])) answered += 1;
  }
  return {
    total,
    answered,
    pct: total ? Math.round((100 * answered) / total) : 0,
  };
}

export function todayIst() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
