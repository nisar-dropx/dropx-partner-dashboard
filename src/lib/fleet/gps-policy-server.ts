import {supabaseAdmin} from '@/lib/supabase-admin';
import {normalizeGpsPolicy} from './gps-policy';
export async function loadGpsPolicy(companyId:string) {
 if(!supabaseAdmin)throw new Error('GPS settings are unavailable.');
 const result=await supabaseAdmin.from('fleet_control_settings').select('risk_weights').eq('company_id',companyId).maybeSingle();
 if(result.error)throw new Error('GPS settings could not be loaded. Retry.');
 return normalizeGpsPolicy(result.data?.risk_weights?.operating_policy?.gps);
}
