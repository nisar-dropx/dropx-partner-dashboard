import {getAuthorization,hasPermission,isCompanyOwner} from './authorization';
import {supabaseAdmin} from './supabase-admin';
import {loadOpsWorkforceLocations} from './ops-workforce-locations';
import {workforceStationPolicy} from './workforce-register-policy';
import {canOnboardDesignation} from './designation-onboarding-access';
import {canAccessDesignationPortal} from './designation-portal-access';
import {daDesignationCodes} from './da-onboarding-policy';
export class OnboardingError extends Error{constructor(message:string,readonly status=400){super(message);}}
export async function onboardingContext(request:Request,stationId:string,action:'access'|'add'|'edit'='access'){
 const auth=await getAuthorization();
 if(!auth?.companyId)throw new OnboardingError('Sign in to continue.',401);
 if(!hasPermission(auth,'workforce_onboarding',action)||!hasPermission(auth,'delivery_associates',action)||(action!=='access'&&(auth.readOnly||auth.isPreview)))throw new OnboardingError('You do not have access to this action.',403);
 if(!['GET','HEAD','OPTIONS'].includes(request.method)&&action!=='access'&&request.headers.get('origin')!==new URL(request.url).origin)throw new OnboardingError('Reload the page before making changes.',403);
 const stations=await loadOpsWorkforceLocations(auth.companyId,auth);
 const station=stations.find(s=>s.id===stationId&&workforceStationPolicy(s).requiresStationEmail);
 if(!station)throw new OnboardingError('Select a station within your access.',403);
 if(!supabaseAdmin)throw new OnboardingError('Onboarding storage unavailable.',503);
 return {auth,db:supabaseAdmin,companyId:auth.companyId,station,scope:stations.map(s=>s.id)};
}
export async function onboardingRoles(ctx:Awaited<ReturnType<typeof onboardingContext>>,request:Request){
 const {db,auth,companyId}=ctx;
 const result=await db.from('designations').select('id,code,name,onboarding_role_ids,portal_permissions').eq('company_id',companyId).eq('is_active',true).in('code',[...daDesignationCodes]).order('code');
 if(result.error)throw new OnboardingError('Unable to load designations.',503);
 const host=new URL(request.url).hostname;
 const portal=host==='ops.dropxlogistics.com'||host.startsWith('dropx-ops-pulse')?'ops':'dashboard';
 return (result.data||[]).filter(r=>canOnboardDesignation(r,auth)&&canAccessDesignationPortal(r,portal,'add',{isOwner:isCompanyOwner(auth)}));
}
