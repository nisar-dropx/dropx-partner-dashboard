import { authorizePaymentEvidence } from '@/lib/payment-evidence-authorization';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { historyWindow, summarizeAdhocHistory, type AdhocHistoryRequest } from '@/lib/payment-adhoc-history';
import { optionalPaymentEvidence } from '@/lib/optional-payment-evidence';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
  try {
    const authorized=await authorizePaymentEvidence(request);
    if('error' in authorized) return authorized.error;
    const {company,payment}=authorized;
    const evidence=await optionalPaymentEvidence(async()=>{
      const db=supabaseAdmin!;
      const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const window=historyWindow(today);
      const heads=await db.from('payment_heads').select('id').eq('company_id',company).eq('code','VAN_ADHOC');
      if(heads.error) throw new Error('History unavailable');
      const fetchScope=async(column:'location_id'|'location_code'|'station_code',value:string|null)=>{
        if(!value || !heads.data?.length) return [];
        const rows:AdhocHistoryRequest[]=[];
        for(let offset=0;offset<5000;offset+=500) {
          const result=await db.from('payment_requests').select('id,work_date,status,approval_status,amount_approved,amount,amount_requested')
            .eq('company_id',company).eq(column,value).in('payment_head_id',heads.data.map(head=>head.id))
            .gte('work_date',window.from).lte('work_date',window.through).order('id').range(offset,offset+499);
          if(result.error) throw new Error('History unavailable');
          rows.push(...(result.data??[]));
          if((result.data?.length??0)<500) return rows;
        }
        throw new Error('History exceeds safe limit');
      };
      const rows=await Promise.all([fetchScope('location_id',payment.location_id),fetchScope('location_code',payment.location_code),fetchScope('station_code',payment.location_code)]);
      return {...summarizeAdhocHistory(rows.flat(),today,payment.id),station:payment.location_code};
    });
    if(!evidence.data) throw new Error('History unavailable');
    return Response.json(evidence.data,{headers:{'Cache-Control':'private, no-store'}});
  } catch {return Response.json({error:'Recent ad hoc unavailable. Review actions remain available.'},{status:503});}
}
