import { NextRequest, NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store"};
function clean(value:unknown){return String(value??"").trim();}
function digits(value:unknown){return clean(value).replace(/\D/g,"");}
async function account(request:NextRequest,body?:Record<string,unknown>){
  const profileType=(body?.profileType??request.nextUrl.searchParams.get("profileType")) as ConnectAccount["profileType"];
  const accountId=clean(body?.accountId??request.nextUrl.searchParams.get("accountId"));
  const current=await requireConnectAccount(profileType,accountId);
  if(current.workspace!=="workforce"||current.activationOnly||!current.pageAccess.includes("refer_earn"))throw new Error("Refer & Earn is not enabled for this Workforce role.");
  if(current.profileType!=="workforce")throw new Error("A canonical Workforce profile is required.");
  return current;
}

export async function GET(request:NextRequest){
  try{
    if(!supabaseAdmin)throw new Error("Referral service is unavailable.");
    const current=await account(request);
    const db=supabaseAdmin;
    const worker=await db.from("workforce").select("id,location_id").eq("company_id",current.companyId).eq("id",current.id).is("deleted_at",null).maybeSingle();
    if(worker.error||!worker.data)throw new Error("Your Workforce profile could not be verified.");
    const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    const [programResult,referralResult,stationResult,sourceResult]=await Promise.all([
      db.from("workforce_referral_programs").select("id,name,reward_amount,qualification_source,qualifying_days,terms,station_id,stations(station_code,station_name)").eq("company_id",current.companyId).eq("is_active",true).lte("effective_from",today).or(`effective_to.is.null,effective_to.gte.${today}`).order("station_id",{ascending:false}).order("effective_from",{ascending:false}),
      db.from("workforce_referrals").select("id,referred_full_name,referred_country_code,referred_mobile,status,qualification_progress,qualifying_days_snapshot,reward_amount_snapshot,qualification_source_snapshot,submitted_at,qualified_at,approved_at,paid_at,stations:preferred_station_id(station_code,station_name),adjustment:workforce_adjustments!workforce_referrals_adjustment_id_fkey(status,payroll_run_id)").eq("company_id",current.companyId).eq("referrer_workforce_id",current.id).order("submitted_at",{ascending:false}),
      db.from("stations").select("id,station_code,station_name").eq("company_id",current.companyId).eq("is_active",true).order("station_code"),
      db.from("workforce_referral_qualification_sources").select("code,name").eq("company_id",current.companyId).eq("is_active",true)
    ]);
    const firstError=[programResult,referralResult,stationResult,sourceResult].find(result=>result.error)?.error;
    if(firstError)throw new Error(firstError.message);
    const stationName=(value:any)=>{const row=Array.isArray(value)?value[0]:value;return row?[row.station_code,row.station_name].filter(Boolean).join(" · "):null;};
    const related=(value:any)=>Array.isArray(value)?value[0]??null:value;
    const sourceNames=new Map((sourceResult.data??[]).map(row=>[row.code,row.name]));
    return NextResponse.json({
      programs:(programResult.data??[]).map((row:any)=>({id:row.id,name:row.name,rewardAmount:Number(row.reward_amount),qualificationSource:row.qualification_source,qualificationSourceName:sourceNames.get(row.qualification_source)??row.qualification_source,qualifyingDays:row.qualifying_days,terms:row.terms,stationId:row.station_id,stationName:stationName(row.stations)})),
      referrals:(referralResult.data??[]).map((row:any)=>{const adjustment=related(row.adjustment);return{id:row.id,name:row.referred_full_name,mobile:`+${row.referred_country_code} ${row.referred_mobile}`,stationName:stationName(row.stations),status:row.status,progress:row.qualification_progress,qualifyingDays:row.qualifying_days_snapshot,rewardAmount:Number(row.reward_amount_snapshot),qualificationSourceName:sourceNames.get(row.qualification_source_snapshot)??row.qualification_source_snapshot,submittedAt:row.submitted_at,qualifiedAt:row.qualified_at,approvedAt:row.approved_at,paidAt:row.paid_at,adjustmentStatus:adjustment?.status??null,inPayroll:Boolean(adjustment?.payroll_run_id)};}),
      stations:(stationResult.data??[]).map(row=>({id:row.id,name:[row.station_code,row.station_name].filter(Boolean).join(" · ")}))
    },{headers});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Unable to load referrals."},{status:400,headers});}
}

export async function POST(request:NextRequest){
  try{
    if(!supabaseAdmin)throw new Error("Referral service is unavailable.");
    const body=await request.json() as Record<string,unknown>;
    const current=await account(request,body);
    const fullName=clean(body.fullName),countryCode=digits(body.countryCode)||"91",mobile=digits(body.mobile),programId=clean(body.programId),stationId=clean(body.stationId);
    if(fullName.length<2||fullName.length>160)throw new Error("Enter the candidate’s full name.");
    if(countryCode.length>4||mobile.length<6||mobile.length>15)throw new Error("Enter a valid mobile number.");
    const db=supabaseAdmin;
    const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    const [worker,program,station]=await Promise.all([
      db.from("workforce").select("id,location_id,mobile,mobile_country_code").eq("company_id",current.companyId).eq("id",current.id).is("deleted_at",null).maybeSingle(),
      db.from("workforce_referral_programs").select("id,station_id,reward_amount,qualification_source,qualifying_days,terms").eq("company_id",current.companyId).eq("id",programId).eq("is_active",true).lte("effective_from",today).or(`effective_to.is.null,effective_to.gte.${today}`).maybeSingle(),
      db.from("stations").select("id").eq("company_id",current.companyId).eq("id",stationId).eq("is_active",true).maybeSingle()
    ]);
    if(worker.error||!worker.data)throw new Error("Your Workforce profile could not be verified.");
    if(program.error||!program.data)throw new Error("Choose an active referral program.");
    if(station.error||!station.data)throw new Error("Choose a valid station.");
    if(program.data.station_id&&program.data.station_id!==stationId)throw new Error("This referral program is not available for the selected station.");
    if(digits(worker.data.mobile)===mobile&&digits(worker.data.mobile_country_code||"91")===countryCode)throw new Error("You cannot refer your own mobile number.");
    const existing=await db.from("workforce").select("id").eq("company_id",current.companyId).or(`mobile.eq.${mobile},mobile.eq.${countryCode}${mobile}`).is("deleted_at",null).limit(2);
    if(existing.error)throw new Error(existing.error.message);
    if((existing.data??[]).length>1)throw new Error("This mobile matches more than one profile. Workforce must resolve the identity before referral submission.");
    const result=await db.from("workforce_referrals").insert({company_id:current.companyId,program_id:program.data.id,referrer_workforce_id:current.id,referred_full_name:fullName,referred_country_code:countryCode,referred_mobile:mobile,preferred_station_id:stationId,referred_workforce_id:existing.data?.[0]?.id??null,status:existing.data?.[0]?.id?"linked":"submitted",reward_amount_snapshot:program.data.reward_amount,qualification_source_snapshot:program.data.qualification_source,qualifying_days_snapshot:program.data.qualifying_days,terms_snapshot:program.data.terms}).select("id").single();
    if(result.error){if(result.error.code==="23505")throw new Error("This mobile number already has an open referral.");throw new Error(result.error.message);}
    return NextResponse.json({ok:true,id:result.data.id},{headers});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Unable to submit referral."},{status:400,headers});}
}
