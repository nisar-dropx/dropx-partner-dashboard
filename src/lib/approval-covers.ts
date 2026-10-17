import "server-only";

import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  remapApproverPeople,
  selectActiveCoverRows,
  type ApprovalCoverTarget,
} from "./approval-covers-core";

export type { ApprovalCoverTarget };
export { remapApproverPeople, selectActiveCoverRows };

/**
 * Active People approval covers for today (IST). Used by Ops Pulse hold / claim
 * desks and SSA routing so an unavailable AOM/CM is replaced by their acting cover.
 * Prefer a workflow-specific row when several match; otherwise use an all-request cover.
 */
export async function loadActiveApprovalCovers(companyId: string, workflowCode?: string | null) {
  if (!supabaseAdmin) throw new Error("Database is unavailable.");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const result = await supabaseAdmin.from("hr_approval_delegations")
    .select("approver_person_id,delegate_person_id,workflow_code,reason,effective_from")
    .eq("company_id", companyId).eq("is_active", true)
    .lte("effective_from", today).gte("effective_to", today);
  if (result.error) {
    if (/does not exist|schema cache/i.test(result.error.message)) return new Map<string, ApprovalCoverTarget>();
    throw new Error(result.error.message);
  }
  const rows = selectActiveCoverRows(result.data ?? [], workflowCode);

  const delegateIds = [...new Set(rows.map((row) => row.delegate_person_id))];
  const names = new Map<string, string>();
  if (delegateIds.length) {
    const people = await supabaseAdmin.from("hr_people").select("id,display_name").eq("company_id", companyId).in("id", delegateIds);
    if (people.error) throw new Error(people.error.message);
    for (const person of people.data ?? []) names.set(person.id, person.display_name);
  }

  const covers = new Map<string, ApprovalCoverTarget>();
  for (const row of rows) {
    if (covers.has(row.approver_person_id)) continue;
    // Ignore obsolete automatic cover after the approved absence is cancelled / expired.
    const automatic = String(row.reason ?? "").match(/^Auto-delegated: (leave|business trip) ([a-f0-9-]{36})$/i);
    if (automatic) {
      const table = automatic[1].toLowerCase() === "leave" ? "hr_leave_requests" : "hr_business_trip_requests";
      const absence = await supabaseAdmin.from(table).select("id").eq("company_id", companyId).eq("id", automatic[2])
        .eq("status", "approved").lte("start_date", today).gte("end_date", today).maybeSingle();
      if (absence.error) throw new Error(absence.error.message);
      if (!absence.data) continue;
    }
    const name = names.get(row.delegate_person_id);
    if (!name) continue;
    covers.set(row.approver_person_id, { personId: row.delegate_person_id, name });
  }
  return covers;
}
