import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { readAllRows } from '@/lib/supabase-pagination';

/** Registrations can be corrected; the UUID continues to identify the same vehicle. */
export async function vehicleRegistrationHistory(companyId:string, vehicleId:string, currentNumber:string) {
  if(!supabaseAdmin)throw Error('Vehicle history is unavailable.');
  const logs=await readAllRows(supabaseAdmin.from('fleet_system_logs').select('before_values,after_values')
    .eq('company_id',companyId).eq('entity','fleet_vehicles').eq('entity_id',vehicleId).eq('event_kind','change')
    .not('before_values->>vehicle_no','is',null).order('created_at').order('id'));
  if(logs.error)throw Error('Registration history could not be loaded. Retry to see the complete history.');
  return [...new Set([currentNumber,...(logs.data??[]).flatMap(row=>[row.before_values?.vehicle_no,row.after_values?.vehicle_no])]
    .filter((value):value is string=>typeof value==='string'&&Boolean(value)).map(value=>value.toUpperCase()))];
}
