import "server-only";
import { supabaseAdmin } from "./supabase-admin";
import { readAllRows } from "./supabase-pagination";
import { loadPeopleOperationalHierarchy } from "./people-operational-hierarchy";
import { loadActiveApprovalCovers } from "./approval-covers";
import { holdApprovers } from "./ops-pulse/salary-hold-policy";

export async function workedIdTrainingRouting(
  company: string,
  stations: string[],
) {
  const [hierarchy, covers, links, profiles] = await Promise.all([
    loadPeopleOperationalHierarchy(company, stations),
    loadActiveApprovalCovers(company, "worked_id_training"),
    readAllRows(
      supabaseAdmin!
        .from("hr_user_person_links")
        .select("person_id,user_id")
        .eq("company_id", company)
        .eq("status", "active")
        .order("id"),
    ),
    readAllRows(
      supabaseAdmin!
        .from("profiles")
        .select("id")
        .eq("company_id", company)
        .eq("is_active", true)
        .order("id"),
    ),
  ]);
  if (hierarchy.error || links.error || profiles.error)
    throw Error(
      "The station’s Cluster Manager/AOM could not be resolved. Check the People reporting hierarchy.",
    );
  const active = new Set((profiles.data || []).map((x) => x.id));
  return (station: string, requester: string) => {
    const ownPeople = new Set(
      (links.data || [])
        .filter((x) => x.user_id === requester)
        .map((x) => x.person_id),
    );
    const route = holdApprovers(
      hierarchy.byLocation.get(station),
      ownPeople,
      covers,
    );
    const users = [
      ...new Set(
        (links.data || [])
          .filter(
            (x) =>
              route.personIds.includes(x.person_id) &&
              x.user_id !== requester &&
              active.has(x.user_id),
          )
          .map((x) => x.user_id),
      ),
    ];
    return { userIds: users, names: route.names, level: route.level };
  };
}
