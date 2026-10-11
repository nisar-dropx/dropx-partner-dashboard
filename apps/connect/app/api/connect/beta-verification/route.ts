import { NextRequest,NextResponse } from 'next/server';
import { requireConnectAccount } from '@/lib/connect-auth';
import { resolveConnectPreview } from '@/lib/connect-preview';
import { supabaseAdmin } from '@/lib/supabase-admin';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
export async function POST(request:NextRequest){
 try{
  if(await resolveConnectPreview())return NextResponse.json({error:'Preview is read-only.'},{status:403,headers});
  const body=await request.json();
  const account=await requireConnectAccount(body.profileType,body.accountId,{allowActivationOnly:true});
  if(account.workspace!=='workforce'||account.profileType!=='workforce'||!account.onboardingBeta||!account.activationStage?.startsWith('amazon_email_pilot:'))return NextResponse.json({error:'This action is only available in your selected private beta account.'},{status:403,headers});
  if(!supabaseAdmin||!['seen','address','pcc_handoff'].includes(body.action))return NextResponse.json({error:'This action is unavailable.'},{status:400,headers});
  const result=await supabaseAdmin.rpc('workforce_beta_verification_response',{p_company:account.companyId,p_candidate:account.id,p_case:body.caseId,p_action:body.action,p_details:body.details??{}});
  if(result.error)return NextResponse.json({error:'Unable to submit. Check every required field and refresh the case before retrying.'},{status:400,headers});
  return NextResponse.json({ok:true},{headers});
 }catch{return NextResponse.json({error:'Unable to submit your response. Please retry.'},{status:400,headers});}
}
