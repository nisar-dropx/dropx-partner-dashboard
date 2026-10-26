import type { AssistantRead } from './assistant-answer';
/** Preserve verified summaries when detailed evidence exceeds the model context budget.
 * The signed download retains the original read; truncation is explicit to the model. */
export function assistantModelRead(read:AssistantRead|{error:string}) {
 if(JSON.stringify(read).length<=50000)return read;
 if('name' in read&&read.name==='ops_attendance_analysis'){
  const {rows,...summary}=read.data;
  return {...read,data:{...summary,rows:rows.slice(0,20),truncated:true,modelViewNote:`Showing 20 of ${rows.length} person rows; totals and rankings use all returned records. Ask for a person/store to inspect other details; full evidence is in the download.`}};
 }
 if('name' in read&&read.name==='ops_store_health_analysis'){
  const rows=read.data.rows||[],latest=new Map<string,any>();
  for(const row of rows)if(!latest.has(row.station_code)||latest.get(row.station_code).report_date<row.report_date)latest.set(row.station_code,row);
  const compact={...read,data:{...read.data,rows:[...latest.values()],scoreHistory:rows.map((r:any)=>({store:r.station_code,date:r.report_date,score:r.values_json?.score_pct,band:r.values_json?.band})),truncated:true,modelViewNote:'Detailed metrics shown only for each store’s latest imported day; score history retains all returned days. Query a narrower date range for historical metric details.'}};
  if(JSON.stringify(compact).length<=50000)return compact;
 }
 return {error:'Detailed result exceeds the context budget. Query fewer stores, a shorter period or a specific person. Full verified evidence remains available in the download.',truncated:true};
}
