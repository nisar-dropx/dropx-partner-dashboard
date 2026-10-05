import "server-only";
import { auditProgrammeFromRiskWeights } from "@/lib/fleet/audit-programme-config";
import { planAuditMonth, type PlanAudit, type PlanVehicle, type PlanStation } from "@/lib/fleet/audit-month-planner";
import { supabaseAdmin } from "@/lib/supabase-admin";
const clean=(value:unknown)=>String(value??'').trim();
const dateString=(year:number,month:number,day:number)=>`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
async function inspectorContext(companyId: string, month: string, enabled: boolean) {
  const membership = await supabaseAdmin!.from("fleet_portal_memberships").select("user_id,access_level,profiles:user_id(email)").eq("company_id", companyId).eq("is_active", true).in("access_level", ["administrator", "approver"]).order("created_at").limit(1).maybeSingle();
  const userId = membership.data?.user_id ?? null;
  if (!enabled || !userId) return { userId, leaveDates: new Set<string>() };
  const profile = Array.isArray((membership.data as any)?.profiles) ? (membership.data as any).profiles[0] : (membership.data as any)?.profiles;
  const email = clean(profile?.email).toLowerCase();
  if (!email) return { userId, leaveDates: new Set<string>() };
  const employee = await supabaseAdmin!.from("employees").select("id").eq("company_id", companyId).ilike("email", email).eq("is_active", true).maybeSingle();
  if (!employee.data?.id) return { userId, leaveDates: new Set<string>() };
  const [year, monthNumber] = month.split("-").map(Number);
  const monthEnd = dateString(year, monthNumber, new Date(year, monthNumber, 0).getDate());
  const leaves = await supabaseAdmin!.from("hr_leave_requests").select("start_date,end_date").eq("company_id", companyId).eq("employee_id", employee.data.id).eq("status", "approved").lte("start_date", monthEnd).gte("end_date", `${month}-01`);
  const dates = new Set<string>();
  for (const leave of leaves.data ?? []) {
    const cursor = new Date(`${leave.start_date}T12:00:00+05:30`); const end = new Date(`${leave.end_date}T12:00:00+05:30`);
    while (cursor <= end) { const value = cursor.toISOString().slice(0, 10); if (value.startsWith(month)) dates.add(value); cursor.setDate(cursor.getDate() + 1); }
  }
  return { userId, leaveDates: dates };
}

export async function generateFleetAuditProgramme(companyId: string, month: string, actorUserId?: string | null, rebalance = false) {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Audit month must be YYYY-MM.");
  const [year, monthNumber] = month.split("-").map(Number);
  const nextMonthDate = new Date(year, monthNumber, 1);
  const nextMonth = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, "0")}-01`;
  const [settings, vehiclesResult, auditsResult, stationsResult, templateResult] = await Promise.all([
    supabaseAdmin.from("fleet_control_settings").select("risk_weights").eq("company_id", companyId).maybeSingle(),
    supabaseAdmin.from("fleet_vehicles").select("id,vehicle_no,station_code,status").eq("company_id", companyId).order("station_code").order("vehicle_no"),
    supabaseAdmin.from("fleet_audits").select("id,vehicle_id,scheduled_for,scheduled_reason,status,assigned_to,updated_at").eq("company_id", companyId).gte("scheduled_for", `${month}-01`).lt("scheduled_for", nextMonth),
    supabaseAdmin.from("stations").select("station_code,latitude,longitude").eq("company_id", companyId),
    supabaseAdmin.from("fleet_audit_templates").select("id").eq("company_id", companyId).eq("is_default", true).eq("is_active", true).maybeSingle()
  ]);
  const firstError = [settings, vehiclesResult, auditsResult, stationsResult, templateResult].find((result) => result.error)?.error;
  if (firstError) throw new Error(firstError.message);
  const config = auditProgrammeFromRiskWeights(settings.data?.risk_weights);
  if (!config.enabled) return { created: 0, moved: 0, vehicles: 0, message: "Automatic audit scheduling is on hold in Settings." };
  const inspector = await inspectorContext(companyId, month, config.autoMoveForLeave);
  const today = new Date(Date.now()+19800000).toISOString().slice(0,10);
  const existing=(auditsResult.data||[]) as PlanAudit[];
  const plan=planAuditMonth({month,today,config,vehicles:(vehiclesResult.data||[]) as PlanVehicle[],audits:existing,stations:(stationsResult.data||[]) as PlanStation[],leaveDates:[...inspector.leaveDates],inspectorId:inspector.userId,rebalance});
  if(!plan.changes.length)return {created:0,moved:0,vehicles:plan.vehicles,message:'Monthly programme is already balanced. No duplicate slots were added.'};
  const result=await supabaseAdmin.rpc('fleet_apply_audit_month_plan',{p_company:companyId,p_month:month+'-01',p_expected:existing.filter(a=>a.status!=='cancelled').map(a=>({id:a.id,status:a.status,updated_at:a.updated_at})),p_changes:plan.changes,p_template:templateResult.data?.id||null,p_actor:actorUserId||inspector.userId});
  if(result.error)throw new Error(result.error.message);
  const saved=result.data as {created:number;moved:number};
  return {...saved,vehicles:plan.vehicles,message:`${saved.created} missing slots added; ${saved.moved} unstarted audits spread across the month. Started and completed audits retained.`};
}
