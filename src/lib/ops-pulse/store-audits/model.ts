/** Versioned, data-driven store inspections. No store IDs, question logic or roles live in the UI. */
export type EvidenceRule = {
  when: "always" | "gap" | "optional";
  min: number;
  max: number;
};
export type Question = {
  id: string;
  label: string;
  guidance: string;
  required: boolean;
  allowNA: boolean;
  evidence: EvidenceRule;
  responseEvidence: EvidenceRule;
  action: string;
  hours: number;
  severity: "critical" | "high" | "normal";
};
export type Section = {
  id: string;
  name: string;
  guidance: string;
  questions: Question[];
};
export type Template = {
  name: string;
  description: string;
  sections: Section[];
};
export type Settings = {
  managerRoles: string[];
  responderRoles: string[];
  modelIds: string[];
  emailEnabled: boolean;
  ccRules: string[];
};
export type Master = {
  company_id: string;
  version: number;
  template: Template;
  settings: Settings;
  updated_at: string;
};
export type Answer = {
  outcome: "" | "pass" | "gap" | "na";
  observation: string;
  action: string;
  owner: string;
  dueAt: string;
};
export type Finding = {
  questionId: string;
  state: "open" | "submitted" | "closed";
  note: string;
  respondedAt?: string;
  respondedBy?: string;
  reviewNote?: string;
  reviewedAt?: string;
  reviewedBy?: string;
};
export type AuditEvent = {
  at: string;
  actor: string;
  kind: string;
  note: string;
};
export type StoreAudit = {
  id: string;
  company_id: string;
  number: string;
  location_id: string;
  store_name: string;
  assigned_to: string;
  assigned_name: string;
  scheduled_for: string;
  status:
    | "scheduled"
    | "in_progress"
    | "awaiting_response"
    | "under_review"
    | "closed"
    | "cancelled";
  template: Template;
  template_version: number;
  answers: Record<string, Answer>;
  findings: Finding[];
  summary: string;
  events: AuditEvent[];
  version: number;
  started_at: string | null;
  completed_at: string | null;
  email_sent_at: string | null;
  email_error: string | null;
  email_recipients: string[];
  deleted_at: string | null;
};
export type Proof = {
  id: string;
  audit_id: string;
  question_id: string;
  phase: "audit" | "response";
  file_name: string;
  content_type: string;
  size: number;
  path: string;
  ready: boolean;
  uploaded_by: string;
  created_at: string;
};
export type Actor = {
  userId: string;
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
export const questions = (t: Template) =>
  t.sections.flatMap((s) => s.questions);
export const emptyAnswer = (): Answer => ({
  outcome: "",
  observation: "",
  action: "",
  owner: "",
  dueAt: "",
});
export function isManager(a: Actor, s: Settings) {
  return (
    a.isMasterOwner ||
    a.effectiveRoleIds.some((id) => s.managerRoles.includes(id))
  );
}
export function inScope(a: Actor, location: string) {
  return a.hasAllLocationAccess || a.locationScopeIds.includes(location);
}
export function canRead(
  a: Actor,
  s: Settings,
  row: Pick<
    StoreAudit,
    "location_id" | "completed_at" | "deleted_at" | "status"
  >,
) {
  return (
    !row.deleted_at &&
    inScope(a, row.location_id) &&
    (isManager(a, s) ||
      (Boolean(row.completed_at) &&
        !["scheduled", "in_progress", "cancelled"].includes(row.status)))
  );
}
export function canRespond(a: Actor, s: Settings, row: StoreAudit) {
  return (
    !a.readOnly &&
    canRead(a, s, row) &&
    Boolean(row.completed_at) &&
    ["awaiting_response", "under_review"].includes(row.status) &&
    Boolean(
      a.permissions.store_audits?.canEdit || a.permissions.store_audits?.canAdd,
    ) &&
    a.effectiveRoleIds.some((id) => s.responderRoles.includes(id))
  );
}
export function canInspect(a: Actor, s: Settings, row: StoreAudit) {
  return (
    !a.readOnly &&
    isManager(a, s) &&
    inScope(a, row.location_id) &&
    a.userId === row.assigned_to &&
    Boolean(a.isMasterOwner || a.permissions.store_audits?.canEdit) &&
    row.status === "in_progress" &&
    !row.completed_at
  );
}
export function requiredEvidence(rule: EvidenceRule, outcome: string) {
  return outcome === "na"
    ? 0
    : rule.when === "always" || (rule.when === "gap" && outcome === "gap")
      ? rule.min
      : 0;
}
export function validateTemplate(t: Template) {
  if (
    !t ||
    !t.name?.trim() ||
    !Array.isArray(t.sections) ||
    !t.sections.length ||
    t.sections.length > 50
  )
    throw Error("Add a name and at least one section.");
  const ids = new Set<string>();
  for (const s of t.sections) {
    if (!s.name?.trim() || !Array.isArray(s.questions) || !s.questions.length)
      throw Error("Every section needs a name and at least one question.");
    for (const x of [s, ...s.questions]) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(x.id) || ids.has(x.id))
        throw Error("Section and question identifiers must be unique.");
      ids.add(x.id);
    }
    for (const q of s.questions) {
      if (
        !q.label?.trim() ||
        q.label.length > 1000 ||
        typeof q.guidance !== "string" ||
        typeof q.action !== "string" ||
        typeof q.required !== "boolean" ||
        typeof q.allowNA !== "boolean" ||
        !["critical", "high", "normal"].includes(q.severity)
      )
        throw Error("Check the question text and response settings.");
      if (!Number.isInteger(q.hours) || q.hours < 1 || q.hours > 2160)
        throw Error("Action timelines must be between 1 and 2160 hours.");
      for (const r of [q.evidence, q.responseEvidence])
        if (
          !r ||
          !["always", "gap", "optional"].includes(r.when) ||
          !Number.isInteger(r.min) ||
          !Number.isInteger(r.max) ||
          r.min < 0 ||
          r.max < r.min ||
          r.max > 20 ||
          (r.when !== "optional" && r.min < 1)
        )
          throw Error(
            "Evidence needs a valid minimum and maximum (0–20 files).",
          );
    }
  }
  if (questions(t).length > 300) throw Error("Use up to 300 questions.");
}
export function validateAnswers(
  row: StoreAudit,
  answers: Record<string, Answer>,
  proofs: Proof[],
  now = Date.now(),
) {
  for (const q of questions(row.template)) {
    const a = answers[q.id];
    if (!a?.outcome) {
      if (q.required) throw Error(`Answer: ${q.label}`);
      continue;
    }
    if (
      !["pass", "gap", "na"].includes(a.outcome) ||
      (a.outcome === "na" && !q.allowNA)
    )
      throw Error(`Choose an allowed outcome: ${q.label}`);
    if (a.outcome === "na" && !a.observation?.trim())
      throw Error(`Explain why this is not applicable: ${q.label}`);
    if (
      a.outcome === "gap" &&
      (!a.observation?.trim() ||
        !a.action?.trim() ||
        !a.owner?.trim() ||
        !Number.isFinite(Date.parse(a.dueAt)) ||
        Date.parse(a.dueAt) <= now)
    )
      throw Error(
        `Add the observation, action, owner and a future deadline: ${q.label}`,
      );
    const count = proofs.filter(
      (p) =>
        p.ready &&
        p.audit_id === row.id &&
        p.question_id === q.id &&
        p.phase === "audit",
    ).length;
    if (
      count < requiredEvidence(q.evidence, a.outcome) ||
      count > q.evidence.max
    )
      throw Error(
        `Check evidence for ${q.label}: ${requiredEvidence(q.evidence, a.outcome)}–${q.evidence.max} files required.`,
      );
  }
}
export function validateResponse(q: Question, note: string, count: number) {
  if (!note.trim())
    throw Error("Describe what was done to correct this finding.");
  if (
    count < requiredEvidence(q.responseEvidence, "gap") ||
    count > q.responseEvidence.max
  )
    throw Error(
      `Attach ${requiredEvidence(q.responseEvidence, "gap")}–${q.responseEvidence.max} files for this response.`,
    );
}
export function findingStatus(findings: Finding[]): StoreAudit["status"] {
  return findings.every((f) => f.state === "closed")
    ? "closed"
    : findings.some((f) => f.state === "submitted")
      ? "under_review"
      : "awaiting_response";
}
export function score(row: Pick<StoreAudit, "template" | "answers">) {
  const a = questions(row.template)
    .map((q) => row.answers[q.id])
    .filter((a) => a && ["pass", "gap"].includes(a.outcome));
  return a.length
    ? Math.round(
        (1000 * a.filter((a) => a.outcome === "pass").length) / a.length,
      ) / 10
    : null;
}
export const statusLabels: Record<StoreAudit["status"], string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  awaiting_response: "Awaiting store response",
  under_review: "Review pending",
  closed: "Closed",
  cancelled: "Cancelled",
};
