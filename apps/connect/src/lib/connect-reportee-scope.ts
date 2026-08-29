import "server-only";

import type { ConnectAccount } from "./connect-auth";
import { connectApproverIdentity } from "./connect-expense-data";
import { collectConnectReporteeAssignmentIds, type ConnectReportingRelationship } from "./connect-reporting-tree";
import { supabaseAdmin } from "./supabase-admin";

export type ConnectReporteeScope = "immediate" | "team";

export type ConnectReporteeAccess = {
  scope: ConnectReporteeScope;
  assignmentIds: Set<string>;
  employeeIds: Set<string>;
  contractorIds: Set<string>;
};

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

function chunks<T>(values: T[], size = 200) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function emptyAccess(scope: ConnectReporteeScope): ConnectReporteeAccess {
  return {
    scope,
    assignmentIds: new Set<string>(),
    employeeIds: new Set<string>(),
    contractorIds: new Set<string>()
  };
}

export function normalizeConnectReporteeScope(value: unknown): ConnectReporteeScope {
  return String(value ?? "").trim().toLowerCase() === "team" ? "team" : "immediate";
}

export function connectReporteeMatches(
  access: ConnectReporteeAccess,
  profileType: unknown,
  profileId: unknown
) {
  const id = String(profileId ?? "").trim();
  if (!id) return false;
  if (profileType === "employee") return access.employeeIds.has(id);
  if (profileType === "contractor") return access.contractorIds.has(id);
  return false;
}

async function activeReportingRelationships(companyId: string, today: string) {
  const rows: ConnectReportingRelationship[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const result = await db().from("hr_reporting_relationships")
      .select("subject_assignment_id,manager_assignment_id")
      .eq("company_id", companyId)
      .eq("relationship_type", "solid_line")
      .eq("is_primary", true)
      .lte("effective_from", today)
      .or(`effective_to.is.null,effective_to.gte.${today}`)
      .order("subject_assignment_id")
      .range(offset, offset + pageSize - 1);
    if (result.error) throw new Error(result.error.message);
    const page = (result.data ?? []) as ConnectReportingRelationship[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

export async function loadConnectReporteeAccess(
  account: ConnectAccount,
  scopeValue: unknown
): Promise<ConnectReporteeAccess> {
  const scope = normalizeConnectReporteeScope(scopeValue);
  let identity;
  try {
    identity = await connectApproverIdentity(account);
  } catch {
    return emptyAccess(scope);
  }

  const relationships = await activeReportingRelationships(account.companyId, identity.today);
  const assignmentIds = collectConnectReporteeAssignmentIds(identity.assignment.id, relationships, scope === "team");
  if (!assignmentIds.size) return emptyAccess(scope);

  const assignmentRows: Array<{ id: string; engagement_id: string }> = [];
  for (const assignmentChunk of chunks([...assignmentIds])) {
    const result = await db().from("hr_work_assignments")
      .select("id,engagement_id")
      .eq("company_id", account.companyId)
      .in("id", assignmentChunk)
      .lte("effective_from", identity.today)
      .or(`effective_to.is.null,effective_to.gte.${identity.today}`);
    if (result.error) throw new Error(result.error.message);
    assignmentRows.push(...((result.data ?? []) as Array<{ id: string; engagement_id: string }>));
  }

  const activeAssignmentIds = new Set(assignmentRows.map((row) => row.id));
  const engagementIds = [...new Set(assignmentRows.map((row) => row.engagement_id).filter(Boolean))];
  const access: ConnectReporteeAccess = {
    scope,
    assignmentIds: activeAssignmentIds,
    employeeIds: new Set<string>(),
    contractorIds: new Set<string>()
  };
  for (const engagementChunk of chunks(engagementIds)) {
    const result = await db().from("hr_engagements")
      .select("worker_type,employee_id,contractor_id")
      .eq("company_id", account.companyId)
      .eq("status", "active")
      .in("id", engagementChunk);
    if (result.error) throw new Error(result.error.message);
    for (const row of result.data ?? []) {
      if (row.worker_type === "employee" && row.employee_id) access.employeeIds.add(row.employee_id);
      if (row.worker_type === "contractor" && row.contractor_id) access.contractorIds.add(row.contractor_id);
    }
  }
  return access;
}
