import {NextRequest,NextResponse} from 'next/server';
import {payoutIdentity,loadAssociatePayouts} from '@/lib/associate-payouts';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {encodePayoutDisputeReason,legacyPayoutDisputeCategory,normalizePayoutDisputeAreas} from '@/lib/payout-dispute';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie'};
const legacyCategories=new Set(['counts','training','loss','tds','other']);

function text(value:unknown){return typeof value==='string'?value.trim():'';}
function validReason(value:unknown,min:number){const reason=text(value);if(reason.length<min||reason.length>2000)throw new Error(`Enter between ${min} and 2000 characters.`);return reason;}
async function ownReviewPublication(company:string,worker:string,publicationId:string){
 const db=supabaseAdmin!;
 const publication=await db.from('workforce_payout_publications').select('id,payroll_run_id,source_calculated_at,review_until,publication_kind,period_start,period_end,station_id,revision').eq('company_id',company).eq('workforce_id',worker).eq('id',publicationId).maybeSingle();
 if(publication.error)throw new Error('Payout review details could not be verified. Refresh and try again.');
 if(!publication.data)throw new Error('This published payout is unavailable for your account.');
 if(publication.data.publication_kind==='worksheet'){
  const latest=await db.from('workforce_payout_publications').select('id').eq('company_id',company).eq('workforce_id',worker).eq('publication_kind','worksheet').eq('period_start',publication.data.period_start).eq('period_end',publication.data.period_end).eq('station_id',publication.data.station_id).order('revision',{ascending:false,nullsFirst:false}).order('published_at',{ascending:false,nullsFirst:false}).order('id',{ascending:false}).limit(1).maybeSingle();
  if(latest.error)throw new Error('Payout review details could not be verified. Refresh and try again.');
  if(latest.data?.id!==publication.data.id)throw new Error('A newer payout revision is available. Refresh before raising a dispute.');
  const deadline=Date.parse(String(publication.data.review_until??''));
  if(!Number.isFinite(deadline)||deadline<=Date.now())throw new Error('The review window for this payout has ended.');
  return publication.data;
 }
 const [run,latest]=await Promise.all([
  db.from('workforce_payroll_runs').select('id,status,calculated_at').eq('company_id',company).eq('id',publication.data.payroll_run_id).maybeSingle(),
  db.from('workforce_payout_publications').select('id').eq('company_id',company).eq('workforce_id',worker).eq('payroll_run_id',publication.data.payroll_run_id).order('revision',{ascending:false,nullsFirst:false}).order('published_at',{ascending:false,nullsFirst:false}).order('id',{ascending:false}).limit(1).maybeSingle(),
 ]);
 if(run.error||latest.error)throw new Error('Payout review details could not be verified. Refresh and try again.');
 if(!run.data||latest.data?.id!==publication.data.id)throw new Error('A newer payout revision is available. Refresh before raising a dispute.');
 if(run.data.status!=='review')throw new Error('This payout is not open for disputes.');
 if(!run.data.calculated_at||!publication.data.source_calculated_at||run.data.calculated_at!==publication.data.source_calculated_at)throw new Error('Workforce is preparing a revised amount. Refresh after it is published.');
 const deadline=Date.parse(String(publication.data.review_until??''));
 if(!Number.isFinite(deadline)||deadline<=Date.now())throw new Error('The review window for this payout has ended.');
 return publication.data;
}
async function ownOpenDispute(company:string,worker:string,disputeId:string){
 const result=await supabaseAdmin!.from('workforce_payout_disputes').select('id,status').eq('company_id',company).eq('workforce_id',worker).eq('id',disputeId).maybeSingle();
 if(result.error)throw new Error('Dispute details could not be verified. Refresh and try again.');
 if(!result.data)throw new Error('This dispute does not belong to your payout history.');
 if(!['open','in_review'].includes(result.data.status))throw new Error('This dispute is already closed.');
 return result.data;
}
export async function GET(request:NextRequest){
 try{const {company,worker}=await payoutIdentity(request);const payouts=await loadAssociatePayouts(company,worker);return NextResponse.json({payouts:payouts.map(p=>({...p,bankAccount:p.bankAccount?'•••• '+p.bankAccount.slice(-4):'Not recorded'}))},{headers});}
 catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Unable to load payouts.'},{status:400,headers});}
}
export async function POST(request:NextRequest){
 try{
  if(request.headers.get('origin')!==request.nextUrl.origin)return NextResponse.json({error:'Invalid request origin'},{status:403,headers});
  const {company,worker}=await payoutIdentity(request),body=await request.json();
  if(!['reply','create'].includes(body.operation))throw new Error('Unsupported dispute action.');
  let result;
  if(body.operation==='reply'){
   const disputeId=text(body.disputeId),reason=validReason(body.reason,3);
   await ownOpenDispute(company,worker,disputeId);
   result=await supabaseAdmin!.rpc('workforce_reply_payout_dispute',{p_company:company,p_workforce:worker,p_dispute:disputeId,p_message:reason});
   if(result.error)throw new Error('The reply could not be sent. Refresh and try again.');
  }else{
   const publicationId=text(body.publicationId);
   await ownReviewPublication(company,worker,publicationId);
   const reason=validReason(body.reason,10),areas=normalizePayoutDisputeAreas(body.categories);
   // Keep cached clients from the previous single-select form working during deployment.
   const legacy=text(body.category);
   if(!areas.length&&!legacyCategories.has(legacy))throw new Error('Select at least one area to dispute.');
   const category=areas.length?legacyPayoutDisputeCategory(areas):legacy;
   const encodedReason=areas.length?encodePayoutDisputeReason(areas,reason):reason;
   if(encodedReason.length>2000)throw new Error('Shorten the dispute details so the selected areas and message fit within 2000 characters.');
   result=await supabaseAdmin!.rpc('workforce_raise_payout_dispute',{p_company:company,p_workforce:worker,p_publication:publicationId,p_category:category,p_reason:encodedReason});
   if(result.error)throw new Error('The dispute could not be sent. Refresh and try again.');
  }
  return NextResponse.json({ok:true},{headers});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Unable to send dispute.'},{status:400,headers});}
}
