import "server-only";

import { supabaseAdmin } from "./supabase-admin";

export type ApprovalJourneyStep = {
  id: string;
  order: number;
  label: string;
  status: string;
  actorName: string | null;
  actedAt: string | null;
  note: string | null;
};

type StepConfig = {
  table: string;
  parentColumn: string;
  orderColumn: string;
  labelColumn: string;
  statusColumn?: string;
  actorColumns: string[];
  actorNameColumn?: string;
  actedAtColumn: string;
  noteColumn: string;
};

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

function text(value: unknown) {
  const result = String(value ?? "").trim();
  return result || null;
}

/** Loads the compact audit trail for approvals already authorized by their list query. */
export async function loadApprovalJourneySteps(companyId: string, parentIds: string[], config: StepConfig) {
  const uniqueIds = [...new Set(parentIds.filter(Boolean))];
  const journeys = new Map<string, ApprovalJourneyStep[]>();
  if (!uniqueIds.length) return journeys;
  const columns = [...new Set([
    "id", config.parentColumn, config.orderColumn, config.labelColumn,
    config.statusColumn ?? "status", ...config.actorColumns,
    config.actorNameColumn, config.actedAtColumn, config.noteColumn
  ].filter((column): column is string => Boolean(column)))];
  const result = await db().from(config.table).select(columns.join(","))
    .eq("company_id", companyId).in(config.parentColumn, uniqueIds).limit(10000);
  if (result.error) throw new Error(result.error.message);
  const rows = (result.data ?? []) as unknown as Array<Record<string, unknown>>;
  const actorIds = [...new Set(rows.flatMap((row) => config.actorColumns.map((column) => text(row[column])).filter((id): id is string => Boolean(id))))];
  const profilesResult = actorIds.length
    ? await db().from("profiles").select("id,full_name,email").eq("company_id", companyId).in("id", actorIds)
    : { data: [], error: null };
  if (profilesResult.error) throw new Error(profilesResult.error.message);
  const actorNames = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile.full_name || profile.email || "Approver"]));
  for (const row of rows) {
    const parentId = text(row[config.parentColumn]);
    if (!parentId) continue;
    const actorId = config.actorColumns.map((column) => text(row[column])).find(Boolean) ?? null;
    const directName = config.actorNameColumn ? text(row[config.actorNameColumn]) : null;
    const step: ApprovalJourneyStep = {
      id: text(row.id) ?? `${parentId}:${row[config.orderColumn]}`,
      order: Number.isFinite(Number(row[config.orderColumn])) ? Number(row[config.orderColumn]) : Date.parse(String(row[config.orderColumn] ?? "")) || 0,
      label: text(row[config.labelColumn]) ?? `Step ${row[config.orderColumn] ?? ""}`.trim(),
      status: text(row[config.statusColumn ?? "status"]) ?? "pending",
      actorName: directName ?? (actorId ? actorNames.get(actorId) ?? "Assigned approver" : null),
      actedAt: text(row[config.actedAtColumn]),
      note: text(row[config.noteColumn])
    };
    journeys.set(parentId, [...(journeys.get(parentId) ?? []), step]);
  }
  for (const steps of journeys.values()) steps.sort((left, right) => left.order - right.order);
  return journeys;
}

export function approvalJourneySummary(submittedAt: string | null | undefined, submittedBy: string, currentStep: string, steps: ApprovalJourneyStep[]) {
  return {
    submittedAt: submittedAt ?? null,
    submittedBy,
    currentStep,
    approvedCount: steps.filter((step) => step.status === "approved").length,
    totalSteps: steps.filter((step) => !["skipped", "cancelled"].includes(step.status)).length,
    steps
  };
}
