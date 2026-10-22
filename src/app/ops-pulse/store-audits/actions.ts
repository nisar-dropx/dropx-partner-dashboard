"use server";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { hasPermission } from "@/lib/authorization";
import {
  context,
  db,
  readAudit,
  stores,
  proofs,
  updateAudit,
  requireManager,
} from "@/lib/ops-pulse/store-audits/server";
import {
  questions,
  validateAnswers,
  canInspect,
  canRespond,
  validateResponse,
  findingStatus,
  fillAmazonPasses,
  scoreSnapshot,
  isManager,
  isResponder,
  type Answer,
  type Finding,
  type AuditType,
} from "@/lib/ops-pulse/store-audits/model";
import {
  loadAuditAssignees,
  canDeleteStationAudit,
} from "@/lib/ops-pulse/station-audit-people";
import { loadStationAuditMaster } from "@/lib/ops-pulse/station-audits";
import { notifyStoreAudit } from "@/lib/ops-pulse/store-audits/mail";
const refresh = () => {
  revalidatePath("/ops-pulse/store-audits");
  revalidatePath("/store-audits");
};
const failure = (e: unknown) => ({
  ok: false as const,
  message: e instanceof Error ? e.message : "Unable to save store audit.",
});
const auditTypes: AuditType[] = ["self", "mock", "amazon"];
function cleanAnswer(a: Answer): Answer {
  const extras: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.extras || {})) {
    if (typeof v === "string" && v.length <= 10000) extras[k] = v;
  }
  let instances =
    a.instances == null || a.instances === undefined
      ? null
      : Number(a.instances);
  if (
    a.outcome === "gap" &&
    (!Number.isFinite(instances) || (instances as number) < 1)
  )
    instances = 1;
  return {
    outcome: a.outcome,
    response: a.response || "",
    observation: a.observation,
    action: a.action,
    owner: a.owner,
    dueAt: a.dueAt,
    instances: Number.isFinite(instances) ? instances : null,
    extras,
    autofilled: Boolean(a.autofilled),
  };
}
export async function scheduleStoreAudit(data: {
  locationId: string;
  auditorId: string;
  scheduledFor: string;
  auditType?: AuditType;
  amazonScore?: number | null;
  amazonAuditor?: string | null;
  id?: string;
  version?: number;
}) {
  try {
    const c = await context();
    const auditType: AuditType = auditTypes.includes(data.auditType as AuditType)
      ? (data.auditType as AuditType)
      : "mock";
    const manager = isManager(c.auth, c.master.settings);
    const responder = isResponder(c.auth, c.master.settings);
    if (c.auth.readOnly) throw Error("Preview is read-only.");
    if (auditType === "self") {
      if (
        !manager &&
        !(
          responder &&
          hasPermission(c.auth, "store_audits", data.id ? "edit" : "add")
        )
      )
        throw Error("Self-audits are for Store Manager / Store In-charge roles.");
    } else {
      requireManager(c, data.id ? "edit" : "add");
    }
    const list = await stores(c.auth, c.master);
    const store = list.find((s) => s.id === data.locationId);
    if (!store) throw Error("Select an authorized store.");
    if (
      !Number.isFinite(Date.parse(data.scheduledFor)) ||
      Date.parse(data.scheduledFor) < Date.now() - 60_000
    )
      throw Error("Choose a future audit date and time.");
    const roleIds =
      auditType === "self"
        ? [
            ...new Set([
              ...c.master.settings.managerRoles,
              ...c.master.settings.responderRoles,
            ]),
          ]
        : c.master.settings.managerRoles;
    const users = await loadAuditAssignees(
      c.companyId,
      roleIds,
      [store.id],
      "store_audits",
    );
    const auditor = users.find(
      (u) => u.id === data.auditorId && u.stationIds.includes(store.id),
    );
    if (!auditor)
      throw Error("Choose an eligible auditor with access to this store.");
    if (auditType === "self" && !manager && auditor.id !== c.auth.userId)
      throw Error("Self-audits must be assigned to you.");
    const amazonScore =
      auditType === "amazon" && data.amazonScore != null
        ? Number(data.amazonScore)
        : null;
    if (
      auditType === "amazon" &&
      amazonScore != null &&
      (!Number.isFinite(amazonScore) || amazonScore < 0 || amazonScore > 100)
    )
      throw Error("Amazon score must be between 0 and 100.");
    const amazonAuditor =
      auditType === "amazon" ? (data.amazonAuditor || "").trim() || null : null;
    const patch = {
      location_id: store.id,
      store_name: `${store.station_code} · ${store.station_name || store.city || ""}`,
      assigned_to: auditor.id,
      assigned_name: auditor.name,
      scheduled_for: data.scheduledFor,
      audit_type: auditType,
      amazon_score: amazonScore,
      amazon_auditor: amazonAuditor,
    };
    if (data.id) {
      const old = await readAudit(data.id, c);
      if (old.audit.status !== "scheduled")
        throw Error("Only a scheduled audit can be reassigned or rescheduled.");
      await updateAudit(
        old,
        patch,
        "rescheduled",
        `Rescheduled (${auditType}) and assigned to ${auditor.name}`,
        data.version!,
      );
    } else {
      const id = randomUUID();
      const r = await db()
        .from("ops_store_audits")
        .insert({
          id,
          company_id: c.companyId,
          number: `STORE-${store.station_code}-${id.slice(0, 8).toUpperCase()}`,
          ...patch,
          template: c.master.template,
          template_version: c.master.version,
          events: [
            {
              at: new Date().toISOString(),
              actor: c.auth.fullName || c.auth.email,
              kind: "scheduled",
              note: `${auditType} audit assigned to ${auditor.name}. Store not notified.`,
            },
          ],
        });
      if (r.error) throw Error(r.error.message);
    }
    refresh();
    return {
      ok: true as const,
      message:
        auditType === "amazon"
          ? "Amazon audit log scheduled. Enter failed questions from the Scout alert."
          : "Audit scheduled privately. The store is not notified.",
    };
  } catch (e) {
    return failure(e);
  }
}
export async function startStoreAudit(
  id: string,
  version: number,
  gps?: { lat: number | null; lng: number | null; presentSmName?: string },
) {
  try {
    const c = await readAudit(id);
    const selfOk =
      c.audit.audit_type === "self" &&
      (isManager(c.auth, c.master.settings) ||
        isResponder(c.auth, c.master.settings));
    if (
      c.auth.readOnly ||
      (!isManager(c.auth, c.master.settings) && !selfOk) ||
      !hasPermission(c.auth, "store_audits", "edit")
    )
      throw Error("Only the assigned auditor can start this scheduled audit.");
    if (c.audit.assigned_to !== c.auth.userId || c.audit.status !== "scheduled")
      throw Error("Only the assigned auditor can start this scheduled audit.");
    if (
      (c.audit.audit_type === "self" || c.audit.audit_type === "mock") &&
      (gps?.lat == null || gps?.lng == null)
    )
      throw Error(
        "Share your GPS location at the store before starting a self or mock audit.",
      );
    await updateAudit(
      c,
      {
        status: "in_progress",
        started_at: new Date().toISOString(),
        started_lat: gps?.lat ?? null,
        started_lng: gps?.lng ?? null,
        present_sm_name: gps?.presentSmName?.trim() || c.audit.present_sm_name,
      },
      "started",
      gps?.lat != null
        ? `Inspection started at GPS ${gps.lat.toFixed(5)}, ${gps.lng!.toFixed(5)}`
        : "Inspection started",
      version,
    );
    refresh();
    return { ok: true as const, message: "Inspection started." };
  } catch (e) {
    return failure(e);
  }
}
export async function saveStoreInspection(
  id: string,
  version: number,
  answers: Record<string, Answer>,
  summary: string,
  submit = false,
  meta?: {
    presentSmName?: string;
    amazonScore?: number | null;
    amazonAuditor?: string | null;
  },
) {
  try {
    const c = await readAudit(id);
    if (!canInspect(c.auth, c.master.settings, c.audit))
      throw Error(
        "Only the assigned auditor can edit an inspection in progress.",
      );
    if (JSON.stringify(answers).length > 500000 || summary.length > 10000)
      throw Error("Inspection text is too large.");
    let cleaned: Record<string, Answer> = {};
    for (const q of questions(c.audit.template)) {
      const a = answers[q.id] ?? c.audit.answers?.[q.id];
      if (a) {
        if (
          !["", "pass", "gap", "na"].includes(a.outcome) ||
          [a.observation, a.action, a.owner, a.dueAt].some(
            (v) => typeof v !== "string" || v.length > 10000,
          )
        )
          throw Error("Invalid inspection response.");
        cleaned[q.id] = cleanAnswer({
          ...a,
          // Client edits clear Amazon autofill unless still the sentinel pass.
          autofilled: Boolean(answers[q.id] ? a.autofilled : a.autofilled),
        });
      }
    }
    if (!submit) {
      const existingAnswered = Object.values(c.audit.answers || {}).filter(
        (a) => a?.outcome,
      ).length;
      const clientAnswered = Object.values(answers || {}).filter(
        (a) => a?.outcome,
      ).length;
      if (existingAnswered > 0 && clientAnswered === 0)
        throw Error(
          "This draft already has answers on the server. Refresh the page, then save again — an empty form was not written over them.",
        );
    }
    if (submit && c.audit.audit_type === "amazon")
      cleaned = fillAmazonPasses(c.audit.template, cleaned);
    if (submit) {
      validateAnswers(c.audit, cleaned, await proofs(c, id));
      if (!summary.trim())
        throw Error("Add a short overall summary before completing the audit.");
      if (c.audit.audit_type === "mock" && !(meta?.presentSmName || "").trim())
        throw Error(
          "Record the Store Manager or Store In-charge present for a mock audit.",
        );
    }
    const findings: Finding[] = questions(c.audit.template)
      .filter((q) => cleaned[q.id]?.outcome === "gap")
      .map((q) => ({ questionId: q.id, state: "open", note: "" }));
    const snap = submit ? scoreSnapshot({ template: c.audit.template, answers: cleaned }) : null;
    const amazonScore =
      c.audit.audit_type === "amazon"
        ? meta?.amazonScore != null
          ? Number(meta.amazonScore)
          : c.audit.amazon_score
        : null;
    const amazonAuditor =
      c.audit.audit_type === "amazon"
        ? meta?.amazonAuditor?.trim() || c.audit.amazon_auditor || null
        : null;
    if (
      submit &&
      c.audit.audit_type === "amazon" &&
      (amazonScore == null ||
        !Number.isFinite(amazonScore) ||
        amazonScore < 0 ||
        amazonScore > 100)
    )
      throw Error("Enter the Amazon score % from the Scout alert (0–100).");
    if (submit && c.audit.audit_type === "amazon" && !amazonAuditor)
      throw Error("Enter the Amazon auditor name from the Scout alert.");
    const saved = await updateAudit(
      c,
      {
        answers: cleaned,
        summary,
        present_sm_name:
          c.audit.audit_type === "mock"
            ? meta?.presentSmName?.trim() || c.audit.present_sm_name || null
            : c.audit.present_sm_name,
        amazon_score: amazonScore,
        amazon_auditor: amazonAuditor,
        ...(submit
          ? {
              findings,
              status: findings.length ? "awaiting_response" : "closed",
              completed_at: new Date().toISOString(),
              score: snap?.percentage ?? null,
              score_band: snap?.band ?? null,
              score_snapshot: snap,
            }
          : {}),
      },
      submit ? "completed" : "draft_saved",
      submit
        ? `${findings.length} gaps · score ${snap?.percentage ?? "—"}% (${snap?.band || "n/a"}). Results released to the store.`
        : "Inspection draft saved",
      version,
    );
    let mail = "";
    if (submit) {
      const result = await notifyStoreAudit(c, saved);
      mail = result;
    }
    refresh();
    return {
      ok: true as const,
      message: submit ? `Audit completed. ${mail}` : "Draft saved.",
      version: saved.version,
    };
  } catch (e) {
    return failure(e);
  }
}
export async function respondStoreFinding(
  id: string,
  version: number,
  questionId: string,
  note: string,
) {
  try {
    const c = await readAudit(id);
    if (!canRespond(c.auth, c.master.settings, c.audit))
      throw Error(
        "Store responses are available only after completion, for authorized store roles.",
      );
    const q = questions(c.audit.template).find((q) => q.id === questionId);
    const f = c.audit.findings.find((f) => f.questionId === questionId);
    if (!q || !f || f.state !== "open")
      throw Error("This finding is not awaiting a response.");
    if (note.length > 10000)
      throw Error("Keep the response under 10,000 characters.");
    validateResponse(
      q,
      note,
      (await proofs(c, id)).filter(
        (p) => p.phase === "response" && p.question_id === questionId,
      ).length,
    );
    const findings = c.audit.findings.map((f) =>
      f.questionId === questionId
        ? {
            ...f,
            note,
            state: "submitted" as const,
            respondedAt: new Date().toISOString(),
            respondedBy: c.auth.fullName || c.auth.email || c.auth.userId,
          }
        : f,
    );
    await updateAudit(
      c,
      { findings, status: findingStatus(findings) },
      "store_responded",
      `${q.label}: ${note}`,
      version,
    );
    refresh();
    return {
      ok: true as const,
      message: "Response submitted for leadership review.",
    };
  } catch (e) {
    return failure(e);
  }
}
export async function reviewStoreFinding(
  id: string,
  version: number,
  questionId: string,
  accept: boolean,
  note: string,
) {
  try {
    const c = await readAudit(id);
    requireManager(c);
    const f = c.audit.findings.find((f) => f.questionId === questionId);
    if (!c.audit.completed_at || !f || f.state !== "submitted")
      throw Error("Only a submitted store response can be reviewed.");
    if (!note.trim() || note.length > 10000)
      throw Error("Add a review note (up to 10,000 characters).");
    const findings = c.audit.findings.map((f) =>
      f.questionId === questionId
        ? {
            ...f,
            state: accept ? ("closed" as const) : ("open" as const),
            reviewNote: note,
            reviewedAt: new Date().toISOString(),
            reviewedBy: c.auth.fullName || c.auth.email || c.auth.userId,
          }
        : f,
    );
    await updateAudit(
      c,
      { findings, status: findingStatus(findings) },
      accept ? "finding_closed" : "response_returned",
      `${questionId}: ${note}`,
      version,
    );
    refresh();
    return {
      ok: true as const,
      message: accept
        ? "Finding closed."
        : "Returned to the store for another response.",
    };
  } catch (e) {
    return failure(e);
  }
}
export async function deleteStoreAudit(
  id: string,
  version: number,
  reason: string,
) {
  try {
    const c = await readAudit(id);
    const m = await loadStationAuditMaster(c.companyId);
    if (!canDeleteStationAudit(c.auth, m.programmeSettings))
      throw Error("Only the named audit deletion users can delete an audit.");
    if (!reason.trim()) throw Error("Record a reason for deletion.");
    await updateAudit(
      c,
      { deleted_at: new Date().toISOString() },
      "deleted",
      reason,
      version,
    );
    refresh();
    return {
      ok: true as const,
      message: "Audit removed from the register. History retained.",
    };
  } catch (e) {
    return failure(e);
  }
}
export async function resendStoreAudit(id: string) {
  try {
    const c = await readAudit(id);
    requireManager(c);
    if (!c.audit.completed_at)
      throw Error("Stores are not notified before audit completion.");
    const result = await notifyStoreAudit(c, c.audit);
    refresh();
    return { ok: true as const, message: result };
  } catch (e) {
    return failure(e);
  }
}
