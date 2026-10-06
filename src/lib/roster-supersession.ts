import type { SupabaseClient } from "@supabase/supabase-js";

type Entry = { plan_id: string; worker_type: string; worker_id: string; roster_date: string; day_type: string; shift_id: string | null };
const personKey = (row: Entry) => row.worker_type + ":" + row.worker_id;

// Supabase builders change type as filters are applied.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pages<T>(query: () => any): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const result = await query().order("id").range(offset, offset + 499);
    if (result.error) throw new Error(result.error.message);
    rows.push(...result.data as T[]);
    if (result.data.length < 500) return rows;
    if (offset >= 100000) throw new Error("Roster history is too large to retire safely.");
  }
}

/** Only an approved, complete replacement may end another approved baseline.
 * Omitted/transferred people keep their previous pattern. Never retire first
 * and then attempt approval: a failed approval must leave today's roster intact.
 */
export async function retireFullyReplacedRosterPlans(admin: SupabaseClient, companyId: string, replacementId: string) {
  const replacement = await admin.from("hr_roster_plans")
    .select("id,status,roster_kind,location_id,effective_from")
    .eq("company_id", companyId).eq("id", replacementId).maybeSingle();
  if (replacement.error) throw new Error(replacement.error.message);
  const plan = replacement.data;
  if (!plan || plan.status !== "approved" || plan.roster_kind !== "recurring_weekly" || !plan.location_id || !plan.effective_from) return 0;
  const entries = await pages<Entry>(() => admin.from("hr_roster_entries")
    .select("plan_id,worker_type,worker_id,roster_date,day_type,shift_id")
    .eq("company_id", companyId).eq("plan_id", replacementId));
  const weekdays = new Map<string, Set<number>>();
  for (const row of entries) {
    if (row.day_type !== "weekly_off" && !(row.day_type === "working" && row.shift_id)) continue;
    const day = new Date(row.roster_date + "T00:00:00Z").getUTCDay();
    if (!Number.isFinite(day)) continue;
    const days = weekdays.get(personKey(row)) ?? new Set<number>();
    days.add(day); weekdays.set(personKey(row), days);
  }
  const complete = new Set([...weekdays].filter(([, days]) => days.size === 7).map(([key]) => key));
  if (!complete.size) return 0;
  const previous = await pages<{id: string}>(() => admin.from("hr_roster_plans")
    .select("id").eq("company_id", companyId).eq("location_id", plan.location_id)
    .eq("roster_kind", "recurring_weekly").eq("status", "approved")
    .is("superseded_at", null).neq("id", plan.id).lte("effective_from", plan.effective_from));
  let retired = 0;
  for (let offset = 0; offset < previous.length; offset += 80) {
    const batch = previous.slice(offset, offset + 80);
    const oldEntries = await pages<Entry>(() => admin.from("hr_roster_entries")
      .select("plan_id,worker_type,worker_id")
      .eq("company_id", companyId).in("plan_id", batch.map(p => p.id)));
    for (const old of batch) {
      const people = oldEntries.filter(row => row.plan_id === old.id);
      if (!people.length || !people.every(row => complete.has(personKey(row)))) continue;
      const ended = await admin.from("hr_roster_plans").update({ superseded_at: plan.effective_from })
        .eq("company_id", companyId).eq("id", old.id).eq("status", "approved").is("superseded_at", null);
      if (ended.error) throw new Error(ended.error.message);
      retired++;
    }
  }
  return retired;
}
