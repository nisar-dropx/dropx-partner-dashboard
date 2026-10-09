import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConnectAccount } from "./connect-auth";
import { todayInIndia } from "./india-date";
import { audienceCopy, personalizeNotice, type AnnouncementContext, type PersonalizableNotice } from "./announcement-personalization";

export async function personalizeNotices<T extends PersonalizableNotice>(db: SupabaseClient, account: ConnectAccount, notices: T[]): Promise<T[]> {
  if (account.workspace !== "people" || !["employee", "contractor"].includes(account.profileType)
    || !notices.some(notice => audienceCopy(notice.data))) return notices;
  const context: AnnouncementContext = {
    workspace: account.workspace, designationCode: account.designationCode, locationModelCode: null, businessLine: null
  };
  const today = todayInIndia();
  const result = await db.from("hr_work_assignments")
    .select("business_line,location:stations!hr_work_assignments_location_id_fkey(company_id,model:location_models!stations_location_model_id_fkey(company_id,code)),engagement:hr_engagements!inner(id)")
    .eq("company_id", account.companyId).eq("is_primary", true)
    .eq("engagement.company_id", account.companyId).eq("engagement.worker_type", account.profileType)
    .eq(`engagement.${account.profileType === "employee" ? "employee_id" : "contractor_id"}`, account.id)
    .eq("engagement.status", "active")
    .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`)
    .order("effective_from", { ascending: false }).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (result.error) {
    // Do not break the notification inbox or expose database details for optional copy.
    // The publisher's fallback must be safe when the current assignment is unavailable.
    console.error("Announcement audience lookup failed", { code: result.error.code });
  } else if (result.data) {
    type Location = { company_id: string; model: { company_id: string; code: string } | null };
    const location = result.data.location as unknown as Location | null;
    context.businessLine = result.data.business_line;
    if (location?.company_id === account.companyId && location.model?.company_id === account.companyId) {
      context.locationModelCode = location.model.code;
    }
  }
  return notices.map(notice => personalizeNotice(notice, context));
}
