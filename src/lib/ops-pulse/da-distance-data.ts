import 'server-only';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {workforceTable} from '@/lib/workforce-profiles';
import type {ConnectAttendanceWorker} from '@/lib/connect-attendance-auth';
import {loadOpenShift} from '@/lib/biometric/attendance-gps';
import {todayKolkata} from './cod';
import {pointInShift} from './da-distance';
export async function distancePilot(worker:ConnectAttendanceWorker){
 if(!supabaseAdmin||!worker.locationId)return null;
 const today=todayKolkata();const r=await supabaseAdmin.from('ops_da_distance_pilots').select('*').eq('company_id',worker.companyId).eq('profile_id',worker.profileId).eq('profile_type',worker.profileType).eq('station_id',worker.locationId).eq('enabled',true).lte('effective_from',today).maybeSingle();
 if(r.error){console.error('Distance pilot configuration',r.error.code);return null;}
 if(!r.data||(r.data.effective_to&&r.data.effective_to<today))return null;
 const person=await supabaseAdmin.from(workforceTable(worker.profileType)).select('is_active,deleted_at,last_working_date').eq('id',worker.profileId).eq('company_id',worker.companyId).maybeSingle();
 if(person.error||!person.data?.is_active||person.data.deleted_at||(person.data.last_working_date&&person.data.last_working_date<today))return null;
 return r.data;
}
export async function captureDistance(worker:ConnectAttendanceWorker,pilot:NonNullable<Awaited<ReturnType<typeof distancePilot>>>,point:{lat:number;lng:number;accuracy_m:number|null;captured_at:string}){
 const shift=await loadOpenShift({companyId:worker.companyId,enrolmentId:worker.enrolmentId});
 if(!pointInShift(Date.parse(point.captured_at),Date.now(),shift.inTime?.getTime()??null,shift.open,Number(pilot.max_shift_hours)))return {saved:false,reason:'Outside open shift'};
 if(!Number.isFinite(point.accuracy_m)||point.accuracy_m===null||point.accuracy_m<0||point.accuracy_m>Number(pilot.max_accuracy_m))return {saved:false,reason:'GPS accuracy insufficient'};
 const r=await supabaseAdmin!.from('ops_da_distance_points').upsert({company_id:worker.companyId,pilot_id:pilot.id,station_id:pilot.station_id,punch_date:shift.punchDate,shift_in:shift.inTime!.toISOString(),shift_sequence:shift.punchCount,...point},{onConflict:'pilot_id,captured_at',ignoreDuplicates:true});
 if(r.error)throw Error('Distance sample could not be recorded.');return {saved:true};
}
