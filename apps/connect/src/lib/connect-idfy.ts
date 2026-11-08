import {requireConnectAccount,type ConnectAccount} from './connect-auth';
import {resolveConnectPreview} from './connect-preview';
import {supabaseAdmin} from './supabase-admin';
export type IdfyOwner={company_id:string;account_id:string;profile_type:string;provider_id:string;identity_email:string};
export async function ownIdfyContext(request:Request){
 if(await resolveConnectPreview())throw new Error('Open your own account to view private verification requests.');
 const p=new URL(request.url).searchParams;
 const account=await requireConnectAccount(p.get('profileType') as ConnectAccount['profileType'],p.get('accountId')||'',{allowActivationOnly:true});
 if(account.workspace!=='workforce'||!supabaseAdmin)throw new Error('Workforce account required.');
 const result=await supabaseAdmin.from('connect_idfy_owners').select('*').eq('company_id',account.companyId).eq('account_id',account.id).eq('profile_type',account.profileType).maybeSingle();
 if(result.error)throw new Error('Verification connection is unavailable.');
 const owner=result.data as IdfyOwner|null;
 const snapshot=owner?await supabaseAdmin.from('amazon_da_detail_snapshots').select('station_id,identity_email,enabled,request_block_ids,requests_checked_at,idfy').eq('company_id',account.companyId).eq('provider_id',owner.provider_id).eq('identity_email',owner.identity_email).eq('enabled',true).maybeSingle():null;
 if(snapshot?.error)throw new Error('Verification status is unavailable.');
 return {account,owner,snapshot:snapshot?.data,db:supabaseAdmin};
}
export async function idfyWorker<T>(operation:string,body:unknown):Promise<T>{
 const url=process.env.WORKFORCE_AMAZON_WORKER_URL?.trim().replace(/\/$/,''),key=process.env.WORKFORCE_AMAZON_WORKER_KEY?.trim();
 if(!url||!key)throw new Error('Verification connection is unavailable.');
 const r=await fetch(`${url}/api/admin/amazon/station-desk/${operation}`,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','x-admin-key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(110000)});
 const data=await r.json();if(!r.ok)throw new Error(data.error||'IDfy could not be reached. Please retry.');return data;
}
