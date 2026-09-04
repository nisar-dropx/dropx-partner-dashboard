import "server-only";

import { resolveConfiguredApprovalWorkflow as resolveSharedWorkflow } from "./approval-workflow-routing";
import { supabaseAdmin } from "./supabase-admin";

export async function resolveConfiguredApprovalWorkflow(input: {
  companyId: string;
  workflowCode: string;
  workerType: "employee" | "contractor";
  workerId: string;
  asOf?: string;
  maxLevel?: 1 | 2 | 3;
}) {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return resolveSharedWorkflow(input);
}
