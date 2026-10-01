import {NextResponse} from 'next/server';
import {getAuthorization,hasPermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {sendCurrentCodStatus} from '@/lib/send-current-cod-status';

export const dynamic='force-dynamic';
export const maxDuration=300;

export async function POST(request:Request){
 const url=new URL(request.url),origin=request.headers.get('origin');
 if(origin&&origin!==url.origin)return Response.json({error:'Invalid request origin.'},{status:403});
 const auth=await getAuthorization();
 if(!auth)return NextResponse.redirect(new URL('/login',url),303);
 if(!hasPermission(auth,'ops_notification_settings','edit'))return NextResponse.redirect(new URL('/unauthorized?page=ops_notification_settings&action=edit',url),303);
 try{
  const result=await sendCurrentCodStatus(requireCompanyId(auth));
  const notice=`Current COD status replied to ${result.accepted} existing monthly email threads.`;
  return NextResponse.redirect(new URL('/settings/notifications?notice='+encodeURIComponent(notice)+'#cod-pending',url),303);
 }catch(error){
  const message=error instanceof Error?error.message:'Current COD status could not be sent.';
  return NextResponse.redirect(new URL('/settings/notifications?error='+encodeURIComponent(message)+'#cod-pending',url),303);
 }
}
