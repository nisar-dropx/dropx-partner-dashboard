import {cronAuthorized,processPortalDigests} from '@/lib/portal-digest-delivery';
import {buildReviewDigest} from '@/lib/review-digest';
import {isEddCronHost} from '@/lib/ops-pulse/edd-cron-scope';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const fetchCache='force-no-store';
export const maxDuration=300;
export async function GET(request:Request){
 if(!cronAuthorized(request))return Response.json({error:'Unauthorized'},{status:401});
 if(!isEddCronHost(new URL(request.url).hostname))return Response.json({skipped:'Ops Pulse only'});
 try{const result=await processPortalDigests('ops','review_digest',buildReviewDigest);return Response.json(result,{status:result.errors.length?500:200});}
 catch(error){console.error('Ops recurring notification failed',error instanceof Error?error.message:'Unknown error');return Response.json({error:'Notification processing failed. Check server logs.'},{status:500});}
}
