/** Versioned, data-driven store inspections. No store IDs, question logic or roles live in the UI. */
export type EvidenceRule = {
  when: "always" | "gap" | "optional";
  min: number;
  max: number;
};
export type ExtraField = {
  id: string;
  label: string;
  type: "number" | "text";
  when: "always" | "gap";
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
  /** yes_no | yes_no_na | count — omitted on older snapshots (treat as yes_no_na via pass/gap/na). */
  kind?: "yes_no" | "yes_no_na" | "count";
  /** False for Counts (N1–N4). Default true when omitted. */
  scored?: boolean;
  /** Amazon "compliant answer": Yes or No. Omitted on older snapshots. */
  compliantAnswer?: "yes" | "no" | null;
  extraFields?: ExtraField[];
  defaultOwner?: string;
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
export type AuditType = "self" | "mock" | "amazon";
export type Answer = {
  outcome: "" | "pass" | "gap" | "na";
  /** Raw Yes/No/NA for polarity-aware questions. */
  response?: "" | "yes" | "no" | "na";
  observation: string;
  action: string;
  owner: string;
  dueAt: string;
  instances?: number | null;
  extras?: Record<string, string>;
  /** Amazon log: auto-marked pass for questions not listed as failed. */
  autofilled?: boolean;
};
export const AMAZON_AUTO_PASS_NOTE =
  "Not listed as failed on Scout alert — marked passed.";
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
export type ScoreBand = "Good" | "Watch" | "Risk";
export type ScoreSnapshot = {
  version: 1;
  percentage: number | null;
  band: ScoreBand | null;
  formula: string;
  sections: {
    id: string;
    name: string;
    percentage: number | null;
    answered: number;
    compliant: number;
    gaps: number;
  }[];
  gaps: { id: string; label: string; instances: number; severity: string }[];
  assessedAt: string;
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
  audit_type: AuditType;
  template: Template;
  template_version: number;
  answers: Record<string, Answer>;
  findings: Finding[];
  summary: string;
  events: AuditEvent[];
  version: number;
  score: number | null;
  score_band: ScoreBand | null;
  score_snapshot: ScoreSnapshot | null;
  amazon_score: number | null;
  amazon_auditor: string | null;
  present_sm_name: string | null;
  started_lat: number | null;
  started_lng: number | null;
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
export const auditTypeLabels: Record<AuditType, string> = {
  self: "Self-audit",
  mock: "Mock audit",
  amazon: "Amazon audit (log)",
};
export const questions = (t: Template) =>
  t.sections.flatMap((s) => s.questions);
export const emptyAnswer = (): Answer => ({
  outcome: "",
  response: "",
  observation: "",
  action: "",
  owner: "",
  dueAt: "",
  instances: null,
  extras: {},
  autofilled: false,
});
export function isScored(q: Question) {
  return q.kind !== "count" && q.scored !== false;
}
export function isCount(q: Question) {
  return q.kind === "count";
}
/** Map Yes/No to pass/gap using the question's compliant answer (Amazon polarity). */
export function outcomeFromResponse(
  q: Question,
  response: Answer["response"] | Answer["outcome"],
): Answer["outcome"] {
  if (!response) return "";
  if (response === "pass" || response === "gap" || response === "na")
    return response;
  if (!isScored(q)) return response === "yes" || response === "no" ? "pass" : "";
  const compliant = q.compliantAnswer === "no" ? "no" : "yes";
  if (response === compliant) return "pass";
  if (response === "yes" || response === "no") return "gap";
  return "";
}
export function applyResponse(
  q: Question,
  response: NonNullable<Answer["response"]>,
  base: Answer = emptyAnswer(),
): Answer {
  const outcome = isCount(q)
    ? response
      ? "pass"
      : ""
    : outcomeFromResponse(q, response);
  return {
    ...base,
    response: isCount(q) ? "" : response,
    outcome,
    ...(outcome === "gap"
      ? {
          action: base.action || q.action,
          owner: base.owner || q.defaultOwner || "",
          dueAt:
            base.dueAt ||
            new Date(Date.now() + q.hours * 3600000).toISOString(),
        }
      : outcome === "pass" || outcome === "na"
        ? { instances: null }
        : {}),
  };
}
export function isManager(a: Actor, s: Settings) {
  return (
    a.isMasterOwner ||
    a.effectiveRoleIds.some((id) => s.managerRoles.includes(id))
  );
}
export function isResponder(a: Actor, s: Settings) {
  return a.effectiveRoleIds.some((id) => s.responderRoles.includes(id));
}
export function inScope(a: Actor, location: string) {
  return a.hasAllLocationAccess || a.locationScopeIds.includes(location);
}
export function canRead(
  a: Actor,
  s: Settings,
  row: Pick<
    StoreAudit,
    | "location_id"
    | "completed_at"
    | "deleted_at"
    | "status"
    | "assigned_to"
    | "audit_type"
  >,
) {
  if (row.deleted_at || !inScope(a, row.location_id)) return false;
  if (isManager(a, s)) return true;
  const type = row.audit_type || "mock";
  const open = ["scheduled", "in_progress"].includes(row.status);
  // Surprise mock stays private until completion. Self & Amazon log are worked by the assignee.
  if (a.userId === row.assigned_to) {
    if (open) return type === "self" || type === "amazon";
    return !["cancelled"].includes(row.status);
  }
  return (
    Boolean(row.completed_at) &&
    !["scheduled", "in_progress", "cancelled"].includes(row.status)
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
    isResponder(a, s)
  );
}
export function canInspect(a: Actor, s: Settings, row: StoreAudit) {
  const selfOk =
    row.audit_type === "self" &&
    (isManager(a, s) || isResponder(a, s));
  return (
    !a.readOnly &&
    (isManager(a, s) || selfOk) &&
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
function validateEvidenceRule(r: EvidenceRule) {
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
    throw Error("Evidence needs a valid minimum and maximum (0–20 files).");
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
      if (
        q.kind != null &&
        !["yes_no", "yes_no_na", "count"].includes(q.kind)
      )
        throw Error("Question kind must be yes_no, yes_no_na or count.");
      if (
        q.compliantAnswer != null &&
        !["yes", "no"].includes(q.compliantAnswer)
      )
        throw Error("Compliant answer must be yes or no.");
      if (q.extraFields) {
        for (const f of q.extraFields) {
          if (
            !f?.id ||
            !/^[a-zA-Z0-9_-]{1,40}$/.test(f.id) ||
            !f.label?.trim() ||
            !["number", "text"].includes(f.type) ||
            !["always", "gap"].includes(f.when)
          )
            throw Error("Check extra input fields on each question.");
        }
      }
      validateEvidenceRule(q.evidence);
      validateEvidenceRule(q.responseEvidence);
    }
  }
  if (questions(t).length > 300) throw Error("Use up to 300 questions.");
}
function fieldNeeded(f: ExtraField, outcome: Answer["outcome"]) {
  return f.when === "always" || (f.when === "gap" && outcome === "gap");
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
      (a.outcome === "na" && !q.allowNA && !isCount(q))
    )
      throw Error(`Choose an allowed outcome: ${q.label}`);
    if (a.outcome === "na" && !a.observation?.trim())
      throw Error(`Explain why this is not applicable: ${q.label}`);
    if (isCount(q)) {
      const count = a.extras?.count?.trim();
      if (!count || !Number.isFinite(Number(count)) || Number(count) < 0)
        throw Error(`Enter the count: ${q.label}`);
    }
    // Amazon autofilled passes skip floor-walk photo / always-extra checks.
    if (a.autofilled && a.outcome === "pass") continue;
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
    if (
      a.outcome === "gap" &&
      isScored(q) &&
      (!Number.isFinite(Number(a.instances)) || Number(a.instances) < 1)
    )
      throw Error(`Record the number of instances: ${q.label}`);
    for (const f of q.extraFields || []) {
      if (f.id === "instances" || f.id === "count") continue;
      if (!fieldNeeded(f, a.outcome)) continue;
      const v = a.extras?.[f.id]?.trim();
      if (!v) throw Error(`Add ${f.label}: ${q.label}`);
      if (f.type === "number" && !Number.isFinite(Number(v)))
        throw Error(`Enter a number for ${f.label}: ${q.label}`);
    }
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
export function scoreBand(pct: number | null): ScoreBand | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct >= 85) return "Good";
  if (pct >= 70) return "Watch";
  return "Risk";
}
/** Equal-weight % of compliant answers among scored pass/gap answers (Counts excluded). */
export function score(row: Pick<StoreAudit, "template" | "answers">) {
  const scored = questions(row.template).filter(isScored);
  const a = scored
    .map((q) => row.answers[q.id])
    .filter((a) => a && ["pass", "gap"].includes(a.outcome));
  return a.length
    ? Math.round(
        (1000 * a.filter((a) => a.outcome === "pass").length) / a.length,
      ) / 10
    : null;
}
export function scoreSnapshot(
  row: Pick<StoreAudit, "template" | "answers">,
  assessedAt = new Date().toISOString(),
): ScoreSnapshot {
  const percentage = score(row);
  const sections = row.template.sections.map((s) => {
    const qs = s.questions.filter(isScored);
    const answered = qs.filter((q) =>
      ["pass", "gap"].includes(row.answers[q.id]?.outcome || ""),
    );
    const compliant = answered.filter(
      (q) => row.answers[q.id]?.outcome === "pass",
    ).length;
    const gaps = answered.length - compliant;
    return {
      id: s.id,
      name: s.name,
      percentage: answered.length
        ? Math.round((1000 * compliant) / answered.length) / 10
        : null,
      answered: answered.length,
      compliant,
      gaps,
    };
  });
  const gaps = questions(row.template)
    .filter((q) => isScored(q) && row.answers[q.id]?.outcome === "gap")
    .map((q) => ({
      id: q.id,
      label: q.label,
      instances: Number(row.answers[q.id]?.instances) || 0,
      severity: q.severity,
    }))
    .sort((a, b) => b.instances - a.instances || a.label.localeCompare(b.label));
  return {
    version: 1,
    percentage,
    band: scoreBand(percentage),
    formula:
      "Compliant answers / (scored questions answered − NA) × 100. Equal weight. Counts not scored.",
    sections,
    gaps,
    assessedAt,
  };
}
/** Fill unanswered scored questions as pass (Amazon log: only failures are entered). */
export function fillAmazonPasses(
  template: Template,
  answers: Record<string, Answer>,
): Record<string, Answer> {
  const next = { ...answers };
  for (const q of questions(template)) {
    if (!isScored(q) || next[q.id]?.outcome) continue;
    next[q.id] = {
      ...emptyAnswer(),
      response: q.compliantAnswer === "no" ? "no" : "yes",
      outcome: "pass",
      observation: AMAZON_AUTO_PASS_NOTE,
      autofilled: true,
    };
  }
  return next;
}
export const statusLabels: Record<StoreAudit["status"], string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  awaiting_response: "Awaiting store response",
  under_review: "Review pending",
  closed: "Closed",
  cancelled: "Cancelled",
};
