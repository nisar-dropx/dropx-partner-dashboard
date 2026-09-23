import 'server-only';
import type {SupabaseClient} from '@supabase/supabase-js';
import {parseReviewCodLine,type ReviewCodLine} from './review-cod';
import {pagedCodRows} from './cod-pending-data';
import {validReportDate} from './cod-pending';
import {buildAgeingStation,previousCodDate,type CodAgeingSnapshot} from './cod-ageing';
/** Pin both reminders to the last complete network import available by the report day's deadline. */
export async function loadCodAgeing(db:SupabaseClient,companyId:string,date:string,stationCodes:string[]):Promise<CodAgeingSnapshot>{
 if(!validReportDate(date))throw new Error('Invalid ageing report date.');
 const snapshot:CodAgeingSnapshot={uploadDate:date,dataDate:previousCodDate(date),batchId:null,importedAt:null,fileName:null,error:null,stations:[]};
 try{
  const result=await db.from('report_import_batches').select('id,file_name,created_at,completed_at,row_count,report_from,report_to').eq('company_id',companyId).eq('source_type','edsp_outstanding_cash').eq('status','Completed').is('station_code',null).gte('created_at',date+'T00:00:00+05:30').lte('created_at',date+'T20:30:00+05:30').lte('completed_at',date+'T20:30:00+05:30').order('completed_at',{ascending:false}).order('id').limit(1).maybeSingle();
  if(result.error)throw new Error(result.error.message);const batch=result.data;
  if(!batch)return {...snapshot,error:'No completed network EDSP outstanding-cash upload was available for this upload date by 8:30 PM. Amounts are unavailable, not zero.'};
  snapshot.batchId=batch.id;snapshot.importedAt=batch.created_at;snapshot.fileName=batch.file_name;
  // EDSP's imported data has no report dates in legacy batches; D-1 is the agreed source convention.
  snapshot.dataDate=batch.report_to||batch.report_from||snapshot.dataDate;
  const count=await db.from('report_import_rows').select('id',{count:'exact',head:true}).eq('company_id',companyId).eq('batch_id',batch.id).eq('source_type','edsp_outstanding_cash');
  if(count.error||count.count!==batch.row_count)throw new Error('Incomplete EDSP import.');
  if(!stationCodes.length)return snapshot;
  const rows=await pagedCodRows<{row_number:number;station_code:string;raw_data:unknown;normalized_data:unknown}>(offset=>db.from('report_import_rows').select('row_number,station_code,raw_data,normalized_data').eq('company_id',companyId).eq('batch_id',batch.id).eq('source_type','edsp_outstanding_cash').in('station_code',stationCodes).order('row_number').order('id').range(offset,offset+999));
  const byStation=new Map<string,ReviewCodLine[]>();for(const row of rows){const line=parseReviewCodLine(row,row.station_code,batch.created_at);if(line){const lines=byStation.get(row.station_code)||[];lines.push(line);byStation.set(row.station_code,lines);}}
  snapshot.stations=stationCodes.map(code=>buildAgeingStation(code,byStation.get(code)||[],snapshot.dataDate)).sort((a,b)=>b.total-a.total||a.stationCode.localeCompare(b.stationCode));
  return snapshot;
 }catch(error){console.error('COD ageing source failed',error);return {...snapshot,error:'The EDSP source could not be verified. Outstanding amounts are unavailable; retry after the import finishes.'};}
}
