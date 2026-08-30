import "server-only";

import { resolveConfiguredApprovalWorkflow as resolveSharedWorkflow } from "../../packages/approval-routing/configured-approval-routing";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function resolveConfiguredApprovalWorkflow(input: {
  companyId: string;
  workflowCode: string;
  workerType: "employee" | "contractor";
  workerId: string;
  asOf?: string;
}) {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return resolveSharedWorkflow(supabaseAdmin, input);
}
