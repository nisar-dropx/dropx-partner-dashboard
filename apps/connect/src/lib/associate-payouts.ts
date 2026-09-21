import {NextRequest} from 'next/server';
import {requireConnectAccount,type ConnectAccount} from '@/lib/connect-auth';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {workforcePaymentStatus} from './workforce-payment-status';
type Row=Record<string,any>;
export async function payoutIdentity(request:NextRequest){
 const account=await requireConnectAccount(request.nextUrl.searchParams.get('profileType') as ConnectAccount['profileType'],request.nextUrl.searchParams.get('accountId')||'');
 if(account.workspace!=='workforce'||!account.pageAccess.includes('earnings')||!supabaseAdmin)throw new Error('Payout access is unavailable.');
 let q=supabaseAdmin.from('workforce').select('id').eq('company_id',account.companyId).is('deleted_at',null).neq('migration_state','reclassified');
 q=account.profileType==='workforce'?q.eq('id',account.id):q.eq('source_profile_type',account.profileType).eq('source_profile_id',account.id);
 const r=await q.maybeSingle();if(r.error||!r.data)throw new Error('Your Workforce identity could not be verified.');
 return {company:account.companyId,worker:r.data.id};
}
async function rows(q:any):Promise<Row[]>{const result:Row[]=[];for(let n=0;n<20000;n+=500){const r=await q.range(n,n+499);if(r.error)throw new Error('Payout details could not be loaded. Please retry.');result.push(...r.data??[]);if((r.data??[]).length<500)return result;}throw new Error('Payout history needs team review.');}
export async function loadAssociatePayouts(company:string,worker:string){
 const db=supabaseAdmin!;
 const pubs=await rows(db.from('workforce_payout_publications').select('*').eq('company_id',company).eq('workforce_id',worker).order('published_at',{ascending:false}).order('id'));
 const items=await rows(db.from('workforce_payroll_items').select('*').eq('company_id',company).eq('workforce_id',worker).order('created_at',{ascending:false}).order('id'));
 const disputes=await rows(db.from('workforce_payout_disputes').select('id,publication_id,payroll_run_id,category,reason,status,resolution,created_at,updated_at').eq('company_id',company).eq('workforce_id',worker).order('created_at').order('id'));
 const runIds=[...new Set([...pubs,...items].map(r=>r.payroll_run_id))],runs:Row[]=[],events:Row[]=[];
 for(let n=0;n<runIds.length;n+=100)runs.push(...await rows(db.from('workforce_payroll_runs').select('id,run_number,period_start,period_end,status,payment_reference,payment_date,paid_at,calculated_at').eq('company_id',company).in('id',runIds.slice(n,n+100)).order('id')));
 for(let n=0;n<disputes.length;n+=100)events.push(...await rows(db.from('workforce_payout_dispute_events').select('id,dispute_id,actor_name,portal,message,created_at').eq('company_id',company).in('dispute_id',disputes.slice(n,n+100).map(d=>d.id)).order('created_at').order('id')));
 const output=[];
 for(const run of runs){
  const pub=pubs.find(p=>p.payroll_run_id===run.id),current=items.find(i=>i.payroll_run_id===run.id),final=['approved','paid'].includes(run.status);
  if(!pub&&!final||run.status==='cancelled')continue;
  let item:Row=pub?.snapshot.item,lines:Row[]=pub?.snapshot.lines??[],status='For your review',paymentDate=null,paymentReference=null;
  if(final&&current){
   const finance=await db.from('payment_requests').select('status,processed_at,utr_cin').eq('company_id',company).eq('source_system','WORKFORCE_PAYROLL').eq('source_id',current.id).maybeSingle();
   if(finance.error)throw new Error('Payment reconciliation could not load.');
   const state=workforcePaymentStatus(current as any,run as any,finance.data);if(!state)continue;
   item=current;status=state.statusLabel;paymentDate=state.paymentDate;paymentReference=state.paymentReference;
   lines=await rows(db.from('workforce_payroll_lines').select('*').eq('company_id',company).eq('workforce_id',worker).eq('payroll_run_id',run.id).order('work_date').order('id'));
  }
  if(!item)continue;
  const detail=lines.map(l=>{const t=l.calculation_snapshot??{},c=t.counts??{};return {date:l.work_date,type:l.source_type,providerId:l.provider_member_id,providerName:t.providerMemberName||null,delivery:Number(c.totalDelivery??l.shipment_count??0),cReturn:Number(c.customerReturn??0),mfn:Number(c.mfn??0),mfnReturn:Number(c.mfnReturn??0),base:Number(l.base_amount),incentive:Number(l.incentive_amount),adjustment:Number(l.adjustment_amount),net:Number(l.net_amount),category:t.correction_kind||t.category||l.source_type,reason:t.correction_reason||t.reason||'',originalAmount:t.original_adjustment??null};});
  output.push({id:run.id,publicationId:pub?.id??null,revision:pub?.revision??null,name:item.worker_name,dropxId:item.dropx_id,station:item.station_code,from:run.period_start,to:run.period_end,status,
   reviewUntil:pub?.review_until??null,canDispute:Boolean(pub)&&['draft','review'].includes(run.status),revisionPending:Boolean(pub)&&pub?.source_calculated_at!==run.calculated_at&&!final,
   bankAccount:String(item.bank_account_no||''),ifsc:item.ifsc_code||'',providerIds:item.provider_member_ids||[],
   days:Number(item.work_days),base:Number(item.base_amount),incentive:Number(item.incentive_amount),additions:Number(item.adjustment_amount),deductions:Number(item.deduction_amount),gross:Number(item.gross_amount),net:Number(item.net_amount),paymentDate,paymentReference,
   counts:{delivery:detail.reduce((n,l)=>n+l.delivery,0),cReturn:detail.reduce((n,l)=>n+l.cReturn,0),mfn:detail.reduce((n,l)=>n+l.mfn,0),mfnReturn:detail.reduce((n,l)=>n+l.mfnReturn,0)},lines:detail,
   disputes:disputes.filter(d=>d.payroll_run_id===run.id).map(d=>({...d,events:events.filter(e=>e.dispute_id===d.id)}))});
 }
 return output.sort((a,b)=>b.to.localeCompare(a.to));
}
