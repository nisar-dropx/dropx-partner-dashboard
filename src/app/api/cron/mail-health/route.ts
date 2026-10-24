import { timingSafeEqual } from 'node:crypto';
import { runWatchdog } from '@/lib/mail-health/server';
import { isDashboardCronRequest } from '@/lib/mail-health/cron-scope';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=300;
export async function GET(request:Request){
 const secret=process.env.CRON_SECRET,actual=Buffer.from(request.headers.get('authorization')??''),expected=Buffer.from(`Bearer ${secret??''}`);
 if(!secret||actual.length!==expected.length||!timingSafeEqual(actual,expected))return Response.json({error:'Unauthorized'},{status:401});
 if(!isDashboardCronRequest(new URL(request.url).hostname,{projectId:process.env.VERCEL_PROJECT_ID,deploymentHost:process.env.VERCEL_URL,productionHost:process.env.VERCEL_PROJECT_PRODUCTION_URL,target:process.env.VERCEL_ENV}))return Response.json({skipped:'Dashboard watchdog only'});
 try{const results=await runWatchdog();console.info('Mail Health watchdog',JSON.stringify(results));return Response.json({results},{status:results.some(r=>'error' in r||r.warnings?.length)?503:200});}
 catch(error){console.error('Mail Health watchdog failed',error instanceof Error?error.message:'Unknown error');return Response.json({error:'Watchdog incomplete. Check logs; no messages were sent.'},{status:503});}
}
