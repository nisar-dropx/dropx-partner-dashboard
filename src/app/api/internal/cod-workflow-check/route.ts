import {loadProgressScrub} from '@/lib/report-bot/lm-scrub-data';
import {highValueOutputs} from '@/lib/report-bot/lm-high-value-output';
import {loadEodDigest} from '@/lib/report-bot/lm-dispatch-data';
import {resolveBankReminderMentions} from '@/lib/report-bot/lm-dispatch-mentions';
import {NextResponse} from 'next/server';
import {timingSafeEqual} from 'node:crypto';
import {reportBotDb} from '@/lib/report-bot/settings';
import {livePerformanceOutputs,routeSources} from '@/lib/report-bot/lm-dispatch';
import {codWorkflowOutputs} from '@/lib/report-bot/lm-cod-workflow-output';
import {loadCodWorkflow} from '@/lib/report-bot/lm-cod-workflow-data';
import {CodRuntime} from '@/lib/report-bot/lm-cod-runtime';
import {queueLoadFlashStations} from '@/lib/ops-pulse/edd-worker';
import {fetchCodStatus} from '@/lib/ops-pulse/cash-recon-worker';
import {codDay} from '@/lib/report-bot/lm-cod-workflow';
export const dynamic='force-dynamic';
export const maxDuration=120;
// Internal read/preview endpoint. It cannot send WhatsApp messages or acknowledge deliveries.
export async function POST(request:Request){
 const secret=process.env.COD_RETURN_API_KEY||'',provided=request.headers.get('authorization')||'';
 const expected=`Bearer ${secret}`;
 if(!secret||Buffer.byteLength(provided)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(provided),Buffer.from(expected)))return NextResponse.json({error:'Unauthorized'},{status:401});
 try{
 const input=await request.json();
 const db=reportBotDb();
 const found=await db.from('report_bot_lm_dispatch_routes').select('*').eq('id',String(input.routeId||'')).single();
 if(found.error||!found.data)return NextResponse.json({error:'Configured bank route not found'},{status:404});
 const route=found.data,company=route.company_id,sources=await routeSources(route,company);
 if(['dsr','creturn'].includes(route.report)&&['performance','refresh-performance'].includes(input.operation)){
  if(input.operation==='refresh-performance')return NextResponse.json(await queueLoadFlashStations(sources.map(s=>s.station_code)));
  const day=codDay(Date.now());
  const digest=await loadEodDigest(sources.map(s=>s.station_code),day,{maxAgeMinutes:5,requireCReturn:route.report==='creturn'});
  const rendered=await livePerformanceOutputs({...route,group:{group_name:''}} as Parameters<typeof livePerformanceOutputs>[0],digest,'',day,new Date(Date.now()+330*60000).toISOString().slice(11,16));
  return NextResponse.json({digest,outputs:rendered.outputs,sent:false});
 }
 if(route.report==='high_value'){const day=codDay(Date.now()),slot=new Date(Date.now()+330*60000).toISOString().slice(11,16);return NextResponse.json({...await highValueOutputs(sources.map(s=>s.station_code),day,slot,Boolean(route.high_value_summary)||route.scope_type==='region',route.high_value_threshold||3000),sent:false});}
 if(route.report==='scrub'){const day=codDay(Date.now());return NextResponse.json({reports:await Promise.all(sources.map(s=>loadProgressScrub(company,s.id,s.report_code||s.station_code,day))),sent:false});}
 if(route.report!=='bank')return NextResponse.json({error:'Use the configured report preview operation'},{status:400});
 const source=sources.find(s=>s.station_code===input.station)||sources[0];
 if(!source)throw new Error('No configured station');
 const day=codDay(Date.now()),slot=new Date(Date.now()+330*60000).toISOString().slice(11,16);
 if(input.operation==='refresh-edd')return NextResponse.json(await queueLoadFlashStations([source.station_code]));
 if(input.operation==='contacts')return NextResponse.json({station:source.station_code,contacts:await resolveBankReminderMentions(company,[source],route,day),sent:false});
 if(input.operation==='source')return NextResponse.json(await fetchCodStatus(source.report_code||source.station_code,false));
 const runtime=new CodRuntime(Date.now()+100000);
 const report=await loadCodWorkflow(company,source,day,slot,route,runtime);
 const outputs=await codWorkflowOutputs(company,source,day,slot,route,runtime);
 return NextResponse.json({station:source.station_code,day,slot,report,outputs:outputs.map(o=>({key:o.key,body:o.body})),sent:false});
 }catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Preview failed'},{status:503});}
}
