'use server';
import {revalidatePath} from 'next/cache';
import {requirePagePermission,hasPermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {loadCodLocations,todayKolkata} from '@/lib/ops-pulse/cod';
import {validDate} from '@/lib/finance/now';
export async function savePilot(form:FormData){
 const a=await requirePagePermission('cps_inputs','edit'),company=requireCompanyId(a);if(!supabaseAdmin)throw Error('Data unavailable.');
 const station=String(form.get('station_id')),workerId=String(form.get('workforce_id')),date=todayKolkata();
 const l=await loadCodLocations(company,a.locationScopeIds,a.hasAllLocationAccess),location=l.locations.find(x=>x.id===station&&!x.is_ho);
 if(l.error||!location)throw Error('Location is outside your access.');
 const result=await supabaseAdmin.rpc('ops_cps_source_facts',{p_company:company,p_from:date,p_through:date,p_stations:[location.station_code]});if(result.error)throw Error('Workforce could not be verified.');
 const person=result.data?.workforce?.find((w:any)=>w.id===workerId&&w.is_active&&w.location_id===station);
 const km=result.data?.mappings?.some((m:any)=>m.workforce_id===workerId&&Number(m.payment_values?.KM_RUN)>0&&m.effective_from<=date&&(!m.effective_to||m.effective_to>=date));
 if(!person||!km)throw Error('Select an active associate with a current kilometre payment rate.');
 const canonical=await supabaseAdmin.from('workforce').select('id').eq('id',person.id).eq('company_id',company).eq('location_id',station).eq('is_active',true).is('deleted_at',null).maybeSingle();if(canonical.error||!canonical.data)throw Error('Current workforce profile could not be verified.');
 const current=await supabaseAdmin.from('ops_da_distance_pilots').select('id,updated_at').eq('company_id',company).eq('profile_id',person.id).eq('profile_type','workforce').maybeSingle();
 if(current.error)throw Error('Pilot could not be loaded.');if(!current.data&&!hasPermission(a,'cps_inputs','add'))throw Error('Master add permission is required.');
 const number=(k:string,min:number,max:number)=>{const n=Number(form.get(k));if(!Number.isFinite(n)||n<min||n>max)throw Error(`Check ${k}.`);return n;};
 const from=String(form.get('effective_from')),to=String(form.get('effective_to')||'');if(!validDate(from)||(to&&(!validDate(to)||to<from)))throw Error('Check effective dates.');
 const row={company_id:company,station_id:station,workforce_id:workerId,profile_id:person.id,profile_type:'workforce',enabled:form.get('enabled')==='on',effective_from:from,effective_to:to||null,max_accuracy_m:number('max_accuracy_m',5,200),max_speed_kmh:number('max_speed_kmh',10,150),max_gap_seconds:number('max_gap_seconds',30,900),max_shift_hours:number('max_shift_hours',1,16),updated_by:a.userId,updated_at:new Date().toISOString()};
 const saved=current.data?await supabaseAdmin.from('ops_da_distance_pilots').update(row).eq('id',current.data.id).eq('company_id',company).eq('updated_at',String(form.get('updated_at'))).select('id'):await supabaseAdmin.from('ops_da_distance_pilots').insert(row).select('id');
 if(saved.error||!saved.data?.length)throw Error('Pilot changed or could not be saved. Reload and retry.');revalidatePath('/attendance/da-distance');
}
