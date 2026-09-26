import 'server-only';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {CodAttachment} from './cod';
export type CodException={id:string;company_id:string;location_id:string;report_date:string;kind:'Banker Not Reported'|'No Cash';reason:string;email_subject:string|null;sender_email:string|null;stakeholder_emails:string[];client_poc_emails:string[];email_cc:string[];email_sent_at:string|null;email_check_status:string;email_check_reason:string|null;email_checked_at:string|null;proof:CodAttachment|null;updater_name:string;updated_at:string;version:number};
export async function loadCodExceptions(db:SupabaseClient,company:string,scope:string[],all:boolean,date:string){
 if(!all&&!scope.length)return [] as CodException[];
 let query=db.from('cod_daily_exceptions').select('*').eq('company_id',company).eq('report_date',date);
 if(!all)query=query.in('location_id',scope);
 const rows:CodException[]=[];
 for(let offset=0;offset<100000;offset+=1000){const {data,error}=await query.order('id').range(offset,offset+999);if(error)throw new Error(error.message);rows.push(...(data||[]) as CodException[]);if((data?.length||0)<1000)return rows;}
 throw new Error('Too many daily updates. Narrow the station scope.');
}
