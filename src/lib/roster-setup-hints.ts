import type { SupabaseClient } from "@supabase/supabase-js";

export type RosterSetupHint = { status: string; label: string };
type Plan = {
  id: string; status: string; roster_kind: string; effective_from: string | null;
  superseded_at: string | null; updated_at: string;
  hr_roster_approval_steps: { stage_no: number; stage_type: string; status: string }[];
};
export function rosterSetupHint(plan: Plan): RosterSetupHint {
  const pending = [...(plan.hr_roster_approval_steps ?? [])]
    .sort((a, b) => a.stage_no - b.stage_no).find(step => step.status === "pending");
  const label = plan.status === "pending_approval"
    ? pending?.stage_type === "hr" ? "Awaiting HR approval" : "Awaiting manager approval"
    : plan.status === "draft" ? "Roster draft · not submitted"
    : plan.status === "returned" ? "Roster returned · revise" : "Roster rejected · revise";
  return { status: plan.status, label };
}
export function rosterHintApplies(plan: Plan, entryDate: string, asOf: string) {
  if (plan.effective_from && plan.effective_from > asOf) return false;
  if (plan.superseded_at && plan.superseded_at <= asOf) return false;
  return plan.roster_kind === "recurring_weekly"
    ? new Date(entryDate + "T00:00:00Z").getUTCDay() === new Date(asOf + "T00:00:00Z").getUTCDay()
    : entryDate === asOf;
}

/** Presentation only: never supplies an approved shift, absence or payroll credit.
 * Worker scope is supplied by the authorised caller; original plan location must
 * not hide a transferred person's setup. Page every source to avoid silent caps.
 */
export async function loadRosterSetupHints(admin: SupabaseClient, companyId: string, workerIds: string[], asOf: string) {
  const hints = new Map<string, RosterSetupHint>();
  if (!workerIds.length) return hints;
  const plans: Plan[] = [];
  for (let offset = 0; ; offset += 500) {
    const result = await admin.from("hr_roster_plans")
      .select("id,status,roster_kind,effective_from,superseded_at,updated_at,hr_roster_approval_steps(stage_no,stage_type,status)")
      .eq("company_id", companyId).in("status", ["pending_approval", "draft", "returned", "rejected"])
      .lte("effective_from", asOf).order("id").range(offset, offset + 499);
    if (result.error) throw new Error(result.error.message);
    plans.push(...result.data as Plan[]);
    if (result.data.length < 500) break;
  }
  const activePlans = plans.filter(p => !p.superseded_at || p.superseded_at > asOf);
  const byId = new Map(activePlans.map(p => [p.id, p]));
  const latest = new Map<string, Plan>();
  for (let p = 0; p < activePlans.length; p += 80) {
    for (let w = 0; w < workerIds.length; w += 80) {
      for (let offset = 0; ; offset += 500) {
        const result = await admin.from("hr_roster_entries")
          .select("plan_id,worker_type,worker_id,roster_date").eq("company_id", companyId)
          .in("plan_id", activePlans.slice(p, p + 80).map(plan => plan.id))
          .in("worker_id", workerIds.slice(w, w + 80))
          .order("id").range(offset, offset + 499);
        if (result.error) throw new Error(result.error.message);
        for (const row of result.data) {
          const plan = byId.get(row.plan_id)!;
          if (!rosterHintApplies(plan, row.roster_date, asOf)) continue;
          const key = row.worker_type + ":" + row.worker_id, prior = latest.get(key);
          if (!prior || plan.updated_at > prior.updated_at || (plan.updated_at === prior.updated_at && plan.id > prior.id)) latest.set(key, plan);
        }
        if (result.data.length < 500) break;
      }
    }
  }
  for (const [key, plan] of latest) hints.set(key, rosterSetupHint(plan));
  return hints;
}

