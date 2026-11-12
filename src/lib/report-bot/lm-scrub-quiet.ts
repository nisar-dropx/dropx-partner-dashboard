import 'server-only';
import {loadProgressScrub} from './lm-scrub-data';
import {quietCodDecision,type CodQuietState} from './lm-cod-quiet';
import {codCacheGet,codCachePut} from './lm-cod-journeys';
import type {CodAck} from './lm-cod-workflow-output';
/** Completion is freshly checked before the quiet-state decision. */
export async function quietScrub(company:string,location:string,code:string,day:string,group:string){
 const report=await loadProgressScrub(company,location,code,day);
 const key=`quiet-scrub:${group}`;
 const prior=await codCacheGet<CodQuietState>(company,location,day,key);
 const ids=report.rows.filter(row=>row[1]==='Pending').map(row=>String(row[0]));
 if(!ids.length){
  if(prior&&report.complete)await codCachePut(company,location,day,key,null);
  return {...report,pending:false,escalation:false,ack:undefined};
 }
 const decision=quietCodDecision(prior,{ids,amount:0},Date.now());
 const ack:CodAck|undefined=decision.send&&decision.next?{company,location,day,keys:[],quiet:[{key,state:decision.next}]}:undefined;
 return {...report,pending:decision.send,escalation:decision.reason==='escalation',ack};
}
