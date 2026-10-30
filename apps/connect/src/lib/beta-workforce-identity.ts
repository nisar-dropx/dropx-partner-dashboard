import type { SupabaseClient } from '@supabase/supabase-js';
import { betaLifecycleEnabled } from './beta-lifecycle.ts';

export type BetaWorkforceIdentity = { dropxId:string; providerId:string; driverId:string; email:string; paymentConfigured:boolean };
/** Read only an explicitly handed-over identity; never infer ownership from names or phones. */
export async function loadBetaWorkforceIdentity(db:SupabaseClient,companyId:string,candidateId:string,options:{includePayments?:boolean}={}):Promise<BetaWorkforceIdentity|null> {
 if(!betaLifecycleEnabled(companyId,candidateId))return null;
 const [candidate,person,link]=await Promise.all([
  db.from('workforce_amazon_email_pilot_candidates').select('alias_email,biometric_id,station_id,closed_at').eq('company_id',companyId).eq('id',candidateId).maybeSingle(),
  db.from('workforce').select('id,dropx_id,provider_employee_id,biometric_id,location_id,source_profile_type,source_profile_id,deleted_at,lifecycle_status').eq('company_id',companyId).eq('id',candidateId).maybeSingle(),
  db.from('workforce_amazon_portal_links').select('transporter_id,amazon_email').eq('company_id',companyId).eq('workforce_id',candidateId).maybeSingle()
 ]);
 if(candidate.error||person.error||link.error)throw new Error('Identity sync unavailable');
 const c=candidate.data,w=person.data,l=link.data;
 if(!c||c.closed_at||!w||w.deleted_at||['inactive','offboarded','terminated'].includes(String(w.lifecycle_status??'').toLowerCase())||!w.dropx_id||!w.provider_employee_id||!l?.transporter_id)return null;
 if(w.source_profile_type!=='canonical'||w.source_profile_id!==candidateId||w.biometric_id!==c.biometric_id||w.location_id!==c.station_id||l.amazon_email?.toLowerCase()!==c.alias_email?.toLowerCase())return null;
 if(options.includePayments===false)return {dropxId:w.dropx_id,providerId:w.provider_employee_id,driverId:l.transporter_id,email:c.alias_email,paymentConfigured:false};
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const payments=await db.from('field_executive_provider_mappings').select('id,payment_method_id').eq('company_id',companyId).eq('workforce_id',candidateId).eq('station_id',c.station_id).eq('provider_member_id',w.provider_employee_id).eq('status','active').lte('effective_from',today).or(`effective_to.is.null,effective_to.gte.${today}`);
 if(payments.error)throw new Error('Payment mapping unavailable');
 return {dropxId:w.dropx_id,providerId:w.provider_employee_id,driverId:l.transporter_id,email:c.alias_email,paymentConfigured:payments.data?.length===1&&Boolean(payments.data[0].payment_method_id)};
}
