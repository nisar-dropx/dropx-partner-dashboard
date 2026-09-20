import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { parseReviewCodLine, summarizeReviewCod, type ReviewCodLine, type ReviewCodSnapshot } from "@/lib/ops-pulse/review-cod";

/** Caller must authorize the company and exact station first. One complete snapshot, never summed imports. */
export async function loadReviewCod(companyId:string,stationCode:string,batchId?:string):Promise<{snapshot:ReviewCodSnapshot;lines:ReviewCodLine[]}> {
  const snapshot:ReviewCodSnapshot={stationCode,batchId:null,importedAt:null,fileName:null,summary:null,error:null};
  if(!supabaseAdmin)return {snapshot:{...snapshot,error:"COD report is temporarily unavailable."},lines:[]};
  const db=supabaseAdmin;
  try {
    let query=db.from("report_import_batches").select("id,created_at,file_name,row_count,station_code")
      .eq("company_id",companyId).eq("source_type","edsp_outstanding_cash").eq("status","Completed")
      .or(`station_code.is.null,station_code.eq.${stationCode}`);
    if(batchId)query=query.eq("id",batchId);
    const batchResult=await query.order("created_at",{ascending:false}).order("id").limit(1).maybeSingle();
    if(batchResult.error)throw batchResult.error;
    const batch=batchResult.data;
    if(!batch)return {snapshot:{...snapshot,error:"No completed EDSP outstanding-cash report is available."},lines:[]};
    snapshot.batchId=batch.id; snapshot.importedAt=batch.created_at; snapshot.fileName=batch.file_name;
    const count=await db.from("report_import_rows").select("id",{count:"exact",head:true}).eq("company_id",companyId).eq("batch_id",batch.id).eq("source_type","edsp_outstanding_cash");
    if(count.error || count.count!==batch.row_count) return {snapshot:{...snapshot,error:"COD report is incomplete. Refresh after the import finishes."},lines:[]};
    const lines:ReviewCodLine[]=[];
    for(let offset=0;offset<20000;offset+=1000) {
      const result=await db.from("report_import_rows").select("row_number,station_code,raw_data,normalized_data")
        .eq("company_id",companyId).eq("batch_id",batch.id).eq("source_type","edsp_outstanding_cash").eq("station_code",stationCode)
        .order("row_number").order("id").range(offset,offset+999);
      if(result.error)throw result.error;
      for(const row of result.data||[]) { const line=parseReviewCodLine(row,stationCode,batch.created_at); if(line)lines.push(line); }
      if((result.data?.length||0)<1000)return {snapshot:{...snapshot,summary:summarizeReviewCod(lines)},lines};
    }
    return {snapshot:{...snapshot,error:"This station report is too large to display safely. Contact the operations team."},lines:[]};
  } catch {
    return {snapshot:{...snapshot,error:"COD report could not be verified. Please refresh or contact the operations team."},lines:[]};
  }
}
