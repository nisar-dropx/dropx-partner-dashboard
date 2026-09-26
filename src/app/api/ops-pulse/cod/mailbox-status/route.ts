import {getAuthorization,hasPermission} from '@/lib/authorization';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {GoogleLocationMailClient} from '@/lib/google-workspace-client';
import {CONTROL_TOWER_CC} from '@/lib/ops-pulse/cod-proof-policy';
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function GET(){
 const auth=await getAuthorization();
 if(!auth?.companyId)return Response.json({error:'Unauthorized'},{status:401});
 if(!hasPermission(auth,'ops_notification_settings','access')||!hasPermission(auth,'cod_reports','access'))return Response.json({error:'Access denied'},{status:403});
 try{
  if(!supabaseAdmin)throw new Error('Database unavailable');
  const setting=await supabaseAdmin.from('google_workspace_settings').select('primary_domain').eq('company_id',auth.companyId).maybeSingle();
  if(setting.error||setting.data?.primary_domain!=='dropxlogistics.com')throw new Error('Workspace domain is not configured');
  // Connection check only: no message body or recipient content is returned.
  await new GoogleLocationMailClient(CONTROL_TOWER_CC,AbortSignal.timeout(20000)).listMessages({query:`cc:${CONTROL_TOWER_CC} newer_than:1d`,maxResults:1});
  return Response.json({connected:true,message:'Control Tower mailbox connected. Recorded Banker Not Reported emails can be checked.'},{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){console.error('COD mailbox connection check failed',error instanceof Error?error.message:'Unknown error');return Response.json({connected:false,message:'Control Tower email checking is unavailable. Check the Google Workspace mailbox connection and delegated Gmail access.'},{status:503,headers:{'Cache-Control':'private, no-store'}});}
}
