import {loadCodExceptions} from './cod-exceptions';
import 'server-only';
import type {SupabaseClient} from '@supabase/supabase-js';
import {buildCodPendingRows,isCodReportStation,validReportDate,type PendingStation,type PendingSlip} from './cod-pending';
export async function pagedCodRows<T>(query:(offset:number)=>PromiseLike<{data:unknown[]|null;error:{message:string}|null}>):Promise<T[]> {
 const rows:T[]=[];
 for(let offset=0;offset<100000;offset+=1000){const result=await query(offset);if(result.error)throw new Error(result.error.message);rows.push(...(result.data||[]) as T[]);if((result.data?.length||0)<1000)return rows;}
 throw new Error('COD report is too large. Narrow the station scope.');
}
export async function loadCodPendingReport(db:SupabaseClient,companyId:string,scope:string[],all:boolean,date:string) {
 if(!companyId||!validReportDate(date))throw new Error('Choose a valid report date.');
 if(!all&&!scope.length)return [];
 const stations=(await pagedCodRows<PendingStation>(offset=>{
  let q=db.from('stations').select('id,station_code,station_name,station_email,hide_from_location_list,providers(code,name),location_models(code,name)').eq('company_id',companyId).eq('is_active',true);
  if(!all)q=q.in('id',scope);return q.order('id').range(offset,offset+999);
 })).filter(isCodReportStation);
 if(!stations.length)return [];
 const slips=await pagedCodRows<PendingSlip>(offset=>db.from('cod_submissions').select('id,location_id,deposit_date,cod_period_from,cod_period_to,cod_date,remittance_code,reference_no,deposited_amount,validated_amount,validation_status,ai_status,ai_summary,ai_result,proof_checked_at,last_updater_name,remarks,validation_remarks,submitter_name,created_at,attachments,deposit_slip_attachments').eq('company_id',companyId).eq('deposit_date',date).in('location_id',stations.map(s=>s.id)).order('id').range(offset,offset+999));
 const exceptions=await loadCodExceptions(db,companyId,scope,all,date);
 return buildCodPendingRows(stations,slips,date,new Date(),exceptions);
}
