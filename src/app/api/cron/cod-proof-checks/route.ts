import {deliverCodReturns} from '@/lib/ops-pulse/cod-return-mail';
import {cronAuthorized} from '@/lib/portal-digest-delivery';
import {isEddCronHost} from '@/lib/ops-pulse/edd-cron-scope';
import {checkCodExceptionEmails} from '@/lib/ops-pulse/cod-exception-mail';
export const dynamic='force-dynamic';export const maxDuration=300;
export async function GET(request:Request){
 if(!cronAuthorized(request))return Response.json({error:'Unauthorized'},{status:401});
 if(!isEddCronHost(new URL(request.url).hostname))return Response.json({skipped:'OpsPulse only'});
 const [email,returns]=await Promise.allSettled([checkCodExceptionEmails(),deliverCodReturns()]);
 const failed=email.status==='rejected'||returns.status==='rejected';
 if(failed)console.error('COD follow-ups failed',email.status==='rejected'?String(email.reason):'',returns.status==='rejected'?String(returns.reason):'');
 return Response.json({returns:returns.status==='fulfilled'?returns.value:{error:'Return notifications unavailable'},proof:{mode:'manual',processed:0},email:email.status==='fulfilled'?email.value:{error:'Mailbox check unavailable'}},{status:failed?500:200});
}
