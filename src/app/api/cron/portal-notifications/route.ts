import {cronAuthorized,processPortalDigests} from '@/lib/portal-digest-delivery';
import {buildReviewDigest} from '@/lib/review-digest';
import {isEddCronHost} from '@/lib/ops-pulse/edd-cron-scope';
import {processPerformanceDataUpdates} from '@/lib/performance-data-updates';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const fetchCache='force-no-store';
export const maxDuration=300;
export async function GET(request:Request){
 if(!cronAuthorized(request))return Response.json({error:'Unauthorized'},{status:401});
 if(!isEddCronHost(new URL(request.url).hostname))return Response.json({skipped:'Ops Pulse only'});
 try{
  const results=await Promise.allSettled([processPortalDigests('ops','review_digest',buildReviewDigest),processPerformanceDataUpdates()]);
  const reports=results.map((result,index)=>result.status==='fulfilled'?result.value:{errors:[`${index===0?'Review digest':'Performance update'} processing failed`]});
  results.forEach(result=>{if(result.status==='rejected')console.error('Ops notification worker failed',result.reason instanceof Error?result.reason.message:'Unknown error');});
  console.info('Ops notifications completed',JSON.stringify(reports));
  return Response.json({reviewDigest:reports[0],performanceDataUpdated:reports[1]},{status:reports.some(r=>r.errors.length)?500:200});
 }
 catch(error){console.error('Ops recurring notification failed',error instanceof Error?error.message:'Unknown error');return Response.json({error:'Notification processing failed. Check server logs.'},{status:500});}
}
