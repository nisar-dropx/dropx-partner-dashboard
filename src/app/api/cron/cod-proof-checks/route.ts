import {cronAuthorized} from '@/lib/portal-digest-delivery';
import {isEddCronHost} from '@/lib/ops-pulse/edd-cron-scope';
import {processCodProofChecks} from '@/lib/ops-pulse/cod-proof-worker';
import {checkCodExceptionEmails} from '@/lib/ops-pulse/cod-exception-mail';
export const dynamic='force-dynamic';export const maxDuration=300;
export async function GET(request:Request){
 if(!cronAuthorized(request))return Response.json({error:'Unauthorized'},{status:401});
 if(!isEddCronHost(new URL(request.url).hostname))return Response.json({skipped:'OpsPulse only'});
 const [proof,email]=await Promise.allSettled([processCodProofChecks(),checkCodExceptionEmails()]);
 const failed=proof.status==='rejected'||email.status==='rejected';
 if(failed)console.error('COD checks failed',proof.status==='rejected'?String(proof.reason):'',email.status==='rejected'?String(email.reason):'');
 return Response.json({proof:proof.status==='fulfilled'?proof.value:{error:'Checks unavailable'},email:email.status==='fulfilled'?email.value:{error:'Mailbox check unavailable'}},{status:failed?500:200});
}
