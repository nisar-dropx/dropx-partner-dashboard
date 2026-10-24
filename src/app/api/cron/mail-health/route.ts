import { timingSafeEqual } from 'node:crypto';
import { runWatchdog } from '@/lib/mail-health/server';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=300;
export async function GET(request:Request){
 const secret=process.env.CRON_SECRET,actual=Buffer.from(request.headers.get('authorization')??''),expected=Buffer.from(`Bearer ${secret??''}`);
 if(!secret||actual.length!==expected.length||!timingSafeEqual(actual,expected))return Response.json({error:'Unauthorized'},{status:401});
 if(new URL(request.url).hostname!=='dashboard.dropxlogistics.com')return Response.json({skipped:'Dashboard watchdog only'});
 try{const results=await runWatchdog();console.info('Mail Health watchdog',JSON.stringify(results));return Response.json({results},{status:results.some(r=>'error' in r||r.warnings?.length)?503:200});}
 catch(error){console.error('Mail Health watchdog failed',error instanceof Error?error.message:'Unknown error');return Response.json({error:'Watchdog incomplete. Check logs; no messages were sent.'},{status:503});}
}
