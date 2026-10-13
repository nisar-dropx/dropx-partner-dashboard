import {NextResponse} from 'next/server';
import {requireConnectAccount,type ConnectAccount} from '@/lib/connect-auth';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {resolveCanonicalPaymentWorker,loadDirectPaymentSetup} from '@/lib/direct-workforce-payment-data';
import {assertNoProviderDirectOverlap} from '@/lib/direct-workforce-payment';
import {paymentReference} from '@/lib/payment-reference';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie'};
export async function GET(request:Request){
  try{
    const q=new URL(request.url).searchParams;
    const account=await requireConnectAccount(q.get('profileType') as ConnectAccount['profileType'],q.get('accountId')||'');
    if(account.workspace!=='workforce'||!account.pageAccess.some(code=>['earnings','rate_card'].includes(code)))return NextResponse.json({error:'Rate card access is unavailable.'},{status:403,headers});
    if(!supabaseAdmin)throw new Error('Rate cards are unavailable. Please retry.');
    const worker=await resolveCanonicalPaymentWorker(account);
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
    const columns:Record<string,string>={employee:'employee_id',contractor:'contractor_id',field_executive:'field_executive_id'};
    const filters=account.profileType==='workforce'?[`workforce_id.eq.${account.id}`]:columns[account.profileType]?[`and(workforce_id.is.null,${columns[account.profileType]}.eq.${account.id})`]:[];
    if(account.profileType==='workforce'&&worker?.source_profile_id&&worker.source_profile_type&&columns[worker.source_profile_type])filters.push(`and(workforce_id.is.null,${columns[worker.source_profile_type]}.eq.${worker.source_profile_id})`);
    const [mapping,direct,overrides]=await Promise.all([
      supabaseAdmin.from('field_executive_provider_mappings').select('id,station_id,provider_member_id,workforce_id,status,effective_from,effective_to,payment_values,stations(station_code),payment_methods(name,payment_method_components(component_code,component_type,label,pay_schedule,is_active,payment_fields(code,label,field_type,pay_schedule,calculation_type)))').eq('company_id',account.companyId).neq('status','cancelled').lte('effective_from',today).or(`effective_to.is.null,effective_to.gte.${today}`).or(filters.length?filters.join(','):'id.eq.00000000-0000-0000-0000-000000000000').limit(1000),
      loadDirectPaymentSetup({companyId:account.companyId,workforceId:worker?.id??null,from:today,to:today}),
      worker?.id?supabaseAdmin.from('workforce_payment_field_overrides').select('station_id,field_code_snapshot,effective_from,effective_to,input_value').eq('company_id',account.companyId).eq('workforce_id',worker.id).lte('effective_from',today).gte('effective_to',today).limit(1000):Promise.resolve({data:[],error:null})
    ]);
    if(mapping.error||overrides.error||(mapping.data??[]).length>=1000||(overrides.data??[]).length>=1000)throw new Error('Your assigned rates could not be verified. Please retry.');
    assertNoProviderDirectOverlap({allocations:direct.allocations,mappings:mapping.data??[],from:today,to:today});
    return NextResponse.json(paymentReference(today,mapping.data??[],direct.allocations,direct.methods,overrides.data??[]),{headers});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Unable to load rate card.'},{status:400,headers});}
}
