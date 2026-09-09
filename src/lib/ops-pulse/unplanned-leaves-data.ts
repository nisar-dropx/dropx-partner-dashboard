import "server-only";
import { hasPermission, isCompanyOwner, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { unplannedDate, type UnplannedWorkspace } from "./unplanned-leaves";

/** Fresh, session-scoped projection. Never calls the mutating People refresh RPC. */
export async function loadOpsUnplannedLeaves(auth: AuthorizationContext, date: string): Promise<UnplannedWorkspace> {
  if (!hasPermission(auth,"ops_unplanned_leaves","access")) throw Error("Unplanned Leaves access is required.");
  if (!supabaseAdmin) throw Error("Attendance service unavailable.");
  const companyId=requireCompanyId(auth);
  unplannedDate(date);
  const policy=await supabaseAdmin.from("portal_notification_controls").select("config")
    .eq("company_id",companyId).eq("portal","people").eq("event_key","unplanned_leave_digest").maybeSingle();
  if(policy.error || !policy.data) throw Error("Attendance visibility settings could not be verified.");
  const codes=policy.data.config?.location_role_codes;
  if(!Array.isArray(codes) || codes.some(c=>typeof c!=="string" || c.length>60)) throw Error("Location team visibility is not configured.");
  const {data,error}=await supabaseAdmin.rpc("ops_unplanned_leave_workspace",{
    p_company_id:companyId,p_user_id:auth.userId,p_attendance_date:date,
    p_owner:isCompanyOwner(auth),p_location_ids:auth.locationScopeIds,p_location_role_codes:codes
  });
  if(error) throw Error(error.code==="42501" ? "Your reporting profile or Ops membership needs checking. Please contact HR." : "Attendance could not be checked. Please retry.");
  if(!data || !Array.isArray(data.rows) || !Array.isArray(data.managers)) throw Error("Attendance response is incomplete.");
  return data as UnplannedWorkspace;
}
