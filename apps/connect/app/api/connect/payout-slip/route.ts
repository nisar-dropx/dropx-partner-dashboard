import {NextRequest,NextResponse} from 'next/server';
import {payoutIdentity,loadAssociatePayouts} from '@/lib/associate-payouts';
import {createPayoutPdf} from '@/lib/payout-pdf';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest){
 try{const {company,worker}=await payoutIdentity(request),p=(await loadAssociatePayouts(company,worker)).find(x=>x.id===request.nextUrl.searchParams.get('runId'));if(!p)return new NextResponse('Payout not found',{status:404});
 const bytes=await createPayoutPdf(p);return new NextResponse(Buffer.from(bytes),{headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="DropX-Payout-'+p.from+'-'+p.to+'.pdf"','Cache-Control':'private, no-store','Vary':'Cookie'}});
 }catch{return new NextResponse('Payout slip could not be generated. Please retry.',{status:400,headers:{'Cache-Control':'private, no-store'}});}
}

