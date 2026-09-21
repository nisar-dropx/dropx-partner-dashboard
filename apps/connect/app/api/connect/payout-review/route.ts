import {NextRequest,NextResponse} from 'next/server';
import {payoutIdentity,loadAssociatePayouts} from '@/lib/associate-payouts';
import {supabaseAdmin} from '@/lib/supabase-admin';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie'};
export async function GET(request:NextRequest){
 try{const {company,worker}=await payoutIdentity(request);const payouts=await loadAssociatePayouts(company,worker);return NextResponse.json({payouts:payouts.map(p=>({...p,bankAccount:p.bankAccount?'•••• '+p.bankAccount.slice(-4):'Not recorded'}))},{headers});}
 catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Unable to load payouts.'},{status:400,headers});}
}
export async function POST(request:NextRequest){
 try{
  if(request.headers.get('origin')!==request.nextUrl.origin)return NextResponse.json({error:'Invalid request origin'},{status:403,headers});
  const {company,worker}=await payoutIdentity(request),body=await request.json();
  if(!['reply','create'].includes(body.operation))throw new Error('Unsupported dispute action.');
  const result=body.operation==='reply'?await supabaseAdmin!.rpc('workforce_reply_payout_dispute',{p_company:company,p_workforce:worker,p_dispute:body.disputeId,p_message:body.reason}):await supabaseAdmin!.rpc('workforce_raise_payout_dispute',{p_company:company,p_workforce:worker,p_publication:body.publicationId,p_category:body.category,p_reason:body.reason});
  if(result.error)throw new Error(result.error.message);
  return NextResponse.json({ok:true},{headers});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Unable to send dispute.'},{status:400,headers});}
}
