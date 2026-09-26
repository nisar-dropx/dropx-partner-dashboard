import 'server-only';
import {supabaseAdmin} from '@/lib/supabase-admin';
export type CodHistoryRow={id:string;submission_id:string|null;exception_id:string|null;event:string;actor_name:string|null;created_at:string;old_values:Record<string,unknown>|null;new_values:Record<string,unknown>};
// IDs must come from the caller's company- and location-scoped report.
export async function loadCodHistory(company:string,submissions:string[],exceptions:string[]){
 const rows:CodHistoryRow[]=[];
 try{
  if(!supabaseAdmin)throw new Error('Database unavailable');
  for(const [column,ids] of [['submission_id',submissions],['exception_id',exceptions]] as const){
   for(let batch=0;batch<ids.length;batch+=100){
    for(let offset=0;offset<100000;offset+=1000){
     const result=await supabaseAdmin.from('cod_proof_history').select('id,submission_id,exception_id,event,actor_name,created_at,old_values,new_values').eq('company_id',company).in(column,ids.slice(batch,batch+100)).order('created_at',{ascending:false}).order('id').range(offset,offset+999);
     if(result.error)throw new Error(result.error.message);
     rows.push(...(result.data||[]) as CodHistoryRow[]);if((result.data?.length||0)<1000)break;
     if(offset===99000)throw new Error('History too large');
    }
   }
  }
  return{rows:rows.sort((a,b)=>b.created_at.localeCompare(a.created_at)),error:''};
 }catch{return{rows:[] as CodHistoryRow[],error:'History could not be loaded. Please retry.'};}
}
