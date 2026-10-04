import {pilotStatus,withLiveAmazonEvidence,type Pilot} from '@/lib/amazon-pilot';
import { loadPartnerOnboardingStates } from "@/lib/partner-onboarding";
import { NextRequest, NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { amazonTasks, amazonTaskStates, joiningStages, joiningState, providerStages, trainingEntitlements, type JoiningAttendance, type JoiningMapping, type JoiningPerson, type JoiningPlan } from "@/lib/workforce-joining";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
// Stop rather than publish a partial calculation if an unexpected history exceeds the limit.
async function allRows(query: any): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0; offset < 10000; offset += 500) {
    const result = await query.range(offset, offset + 499);
    if (result.error) throw new Error("Joining records could not be loaded.");
    rows.push(...result.data ?? []);
    if ((result.data?.length ?? 0) < 500) return rows;
  }
  throw new Error("Your history needs a team review before it can be displayed.");
}

export async function GET(request: NextRequest) {
  try {
    const account = await requireConnectAccount(request.nextUrl.searchParams.get("profileType") as ConnectAccount["profileType"], request.nextUrl.searchParams.get("accountId") ?? "",{allowActivationOnly:true});
    if (account.workspace !== "workforce" || (!account.activationOnly && !account.pageAccess.some(code => ["dashboard", "earnings", "profile"].includes(code)))) return NextResponse.json({error:"This view is not enabled for your account."},{status:403,headers});
    if (!supabaseAdmin) throw new Error("Joining details are temporarily unavailable.");
    const db = supabaseAdmin, company = account.companyId;
    let personQuery = db.from("workforce").select("id,email,location_id,source_profile_type,source_profile_id,onboarding_status,lifecycle_status,is_active,onboarding_approved_at,last_working_date")
      .eq("company_id",company).is("deleted_at",null).neq("migration_state","reclassified");
    personQuery = account.profileType === "workforce" ? personQuery.eq("id",account.id) : personQuery.eq("source_profile_type",account.profileType).eq("source_profile_id",account.id);
    const personResult = await personQuery.maybeSingle();
    if (personResult.error) throw new Error("Your Workforce record could not be verified.");
    if (!personResult.data) return NextResponse.json({available:false},{headers});
    const person = personResult.data as JoiningPerson;
    const pilot=await db.from("workforce_amazon_pilots").select("*").eq("company_id",company).eq("workforce_id",person.id).maybeSingle();
    if(pilot.error && !["42P01","PGRST205"].includes(pilot.error.code)) throw new Error("Onboarding status unavailable.");
    if(pilot.data){
      const [invitation,portal,registrationDraft,liveSources,exitReasons]=await Promise.all([
        db.from("workforce_amazon_invitation_requests").select("status,external_reference,completed_at,error_message").eq("company_id",company).eq("workforce_id",person.id).order("requested_at",{ascending:false}).limit(1).maybeSingle(),
        db.from("workforce_amazon_portal_links").select("amazon_provider_id,transporter_id").eq("company_id",company).eq("workforce_id",person.id).maybeSingle(),
        db.from("mob_app_registration_drafts").select("draft_data,updated_at").eq("company_id",company).eq("profile_type",account.profileType).eq("account_id",person.id).maybeSingle(),
        db.rpc("workforce_amazon_pilot_sources",{p_company:company,p_workforce:person.id}),
        db.from("workforce_onboarding_exit_reasons").select("id,label,description,requires_note").eq("company_id",company).eq("client_code","AMAZON").eq("is_active",true).order("sort_order").order("label")
      ]);
      const base=pilot.data as Pilot;
      const sourceEvidence=liveSources.error||!liveSources.data?base.evidence:liveSources.data as Pilot["evidence"];
      const p={...base,evidence:withLiveAmazonEvidence(sourceEvidence,invitation.data,portal.data)};
      const s=pilotStatus(p);
      const betaData=(registrationDraft.data?.draft_data??{}) as Record<string,unknown>;
      const betaSubmitted=betaData._beta_status==="submitted";
      const registrationRequired=["pending","returned"].includes(String(person.onboarding_status??"").toLowerCase())&&!betaSubmitted;
      return NextResponse.json({available:true,pilot:true,stage:s.stage,stageLabel:s.label,instruction:s.instruction,reportUpdatedAt:p.evidence.reportSyncedAt,reportDate:p.evidence.reportDate,stale:s.stale,syncDelayed:Boolean(p.sync_error),driverId:p.evidence.employeeId??null,biometricId:account.biometricId,amazonAccountId:p.evidence.providerId,invitationEmail:person.email??account.email,registrationRequired,registrationStatus:betaSubmitted?"submitted":person.onboarding_status,offboardingRequested:Boolean(p.closed_at&&p.exit_requested_source==='associate'),offboardingRequestedAt:p.exit_requested_at??null,exitReasons:exitReasons.data??[],actionOwner:s.owner,category:s.category,amazonAction:s.action,configured:true,mode:null,firstPunch:null,mappingEffectiveFrom:null,providerStage:null,nextFollowUp:null,updatedAt:p.evidence.invitationAt||p.last_checked_at,tasks:[],training:null},{headers});
    }

    const partnerState=(await loadPartnerOnboardingStates(db,company,[person.id])).get(person.id);
    if(account.activationOnly && partnerState) return NextResponse.json({available:true,stage:partnerState.stage,stageLabel:partnerState.label,instruction:partnerState.instruction,reportDate:partnerState.report_date,reportUpdatedAt:partnerState.report_updated_at,configured:true,mode:null,firstPunch:null,mappingEffectiveFrom:null,providerStage:partnerState.label,nextFollowUp:null,updatedAt:null,tasks:[],training:null},{headers});
    const ids = [{column:"workforce_id",id:person.id}];
    if (person.source_profile_id && ["contractor","field_executive"].includes(person.source_profile_type ?? "")) ids.push({column:`${person.source_profile_type}_id`,id:person.source_profile_id});
    const [planResult, mappingLists] = await Promise.all([
      db.from("workforce_joining_plans").select("*").eq("company_id",company).eq("workforce_id",person.id).maybeSingle(),
      Promise.all(ids.map(({column,id}) => allRows(db.from("field_executive_provider_mappings").select("id,workforce_id,field_executive_id,contractor_id,employee_id,effective_from,effective_to,status,provider_member_id,station_id").eq("company_id",company).eq(column,id).neq("status","cancelled").order("effective_from").order("id"))))
    ]);
    if (planResult.error) throw new Error("Your joining plan is temporarily unavailable.");
    const plan = planResult.data as JoiningPlan | null;
    const mappings = [...new Map(mappingLists.flat().map(row=>[row.id,row])).values()] as JoiningMapping[];
    const today = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    let attendance: JoiningAttendance[] = [];
    if (plan) {
      const lists = await Promise.all(ids.map(({column,id}) => allRows(db.from("attendance_daily").select("id,workforce_id,field_executive_id,contractor_id,punch_date,in_time,out_time,work_minutes,status,punch_in_location_id,location_id,in_source,out_source,enrolment_id,updated_at").eq("company_id",company).eq(column,id).gte("punch_date",plan.eligible_from).lte("punch_date",today).order("punch_date").order("id"))));
      attendance = [...new Map(lists.flat().map(row=>[row.id,row])).values()] as JoiningAttendance[];
      const enrolments = [...new Set(attendance.map(row=>row.enrolment_id).filter(Boolean))];
      const flags = new Set<string>();
      for (let i=0;i<enrolments.length;i+=100) {
        const rows = await allRows(db.from("attendance_punches").select("id,enrolment_id,punch_date").eq("company_id",company).in("enrolment_id",enrolments.slice(i,i+100)).eq("is_flagged",true).gte("punch_date",plan.eligible_from).lte("punch_date",today).order("id"));
        rows.forEach(row=>flags.add(`${row.enrolment_id}:${row.punch_date}`));
      }
      attendance = attendance.map(row=>({...row,flagged:flags.has(`${row.enrolment_id}:${row.punch_date}`)}));
    }
    const state = joiningState(person,plan,mappings,attendance,today);
    const entitlements = plan ? trainingEntitlements(person,plan,mappings,attendance,plan.eligible_from,today) : [];
    const payVisible = !account.activationOnly && account.pageAccess.includes("earnings");
    const paymentHolds = payVisible ? await allRows(db.from('workforce_payment_holds').select('id,period_start,period_end,status,requested_at').eq('company_id',company).eq('workforce_id',person.id).neq('status','released').order('requested_at',{ascending:false}).order('id')) : [];
    // Deliberate allowlist: internal notes, portal credentials, other staff and documents never leave this endpoint.
    return NextResponse.json({
      available:true,stage:state.stage,stageLabel:joiningStages[state.stage],configured:Boolean(plan),mode:plan?.mode ?? null,
      paymentHolds:paymentHolds.map(row=>({id:row.id,from:row.period_start,to:row.period_end,status:row.status,placedAt:row.requested_at})),
      firstPunch:state.firstPunch,mappingEffectiveFrom:state.mapping?.effective_from ?? null,
      providerStage:plan ? providerStages[plan.provider_stage] : null,nextFollowUp:plan?.next_follow_up_on ?? null,updatedAt:plan?.updated_at ?? null,
      tasks:plan ? Object.entries(amazonTasks).filter(([,task])=>task.owner==="Associate").map(([code,task])=>({code,label:task.label,status:amazonTaskStates[plan.amazon_tasks?.[code as keyof typeof amazonTasks] ?? "pending"]})) : [],
      training:!account.activationOnly&&plan?.mode === "training" ? {dailyRate:payVisible ? Number(plan.daily_rate ?? 0):null,minimumMinutes:plan.minimum_minutes,acceptedOn:plan.terms_accepted_on,
        eligibleDays:entitlements.filter(row=>!row.holds.length).length,reviewDays:entitlements.filter(row=>row.holds.length).length,
        eligibleAmount:payVisible ? entitlements.filter(row=>!row.holds.length).reduce((sum,row)=>sum+row.amount,0):null,
        days:entitlements.map(row=>({date:row.attendance.punch_date,minutes:Number(row.attendance.work_minutes ?? 0),amount:payVisible ? row.amount:null,holds:row.holds})).sort((a,b)=>b.date.localeCompare(a.date))} : null
    },{headers});
  } catch {
    return NextResponse.json({error:"We could not load your joining details. Please retry, or sign in again if your session expired."},{status:400,headers});
  }
}

export async function POST(request:NextRequest){
 try{
  const body=await request.json() as {accountId?:string;profileType?:ConnectAccount["profileType"];action?:string;reasonId?:string;note?:string};
  const account=await requireConnectAccount(body.profileType as ConnectAccount["profileType"],body.accountId??"",{allowActivationOnly:true});
  if(account.workspace!=="workforce"||body.action!=="not_continuing")return NextResponse.json({error:"This action is unavailable."},{status:403,headers});
  if(!supabaseAdmin)throw new Error("Onboarding is temporarily unavailable.");
  const note=String(body.note??"").trim();
  if(!body.reasonId||note.length>1000)return NextResponse.json({error:"Choose a reason and keep the note under 1,000 characters."},{status:400,headers});
  let personQuery=supabaseAdmin.from("workforce").select("id").eq("company_id",account.companyId).is("deleted_at",null).neq("migration_state","reclassified");
  personQuery=account.profileType==="workforce"?personQuery.eq("id",account.id):personQuery.eq("source_profile_type",account.profileType).eq("source_profile_id",account.id);
  const person=await personQuery.maybeSingle();
  if(person.error||!person.data)return NextResponse.json({error:"Your onboarding record could not be verified."},{status:404,headers});
  const result=await supabaseAdmin.rpc("workforce_submit_amazon_pilot_exit",{p_company:account.companyId,p_workforce:person.data.id,p_reason:body.reasonId,p_note:note});
  if(result.error)throw new Error(result.error.message);
  return NextResponse.json({ok:true},{headers});
 }catch(error){
  return NextResponse.json({error:error instanceof Error?error.message:"We could not save your decision."},{status:400,headers});
 }
}
