import {loadCodWorkflow,type CodConfig} from './lm-cod-workflow-data';
import {CodRuntime} from './lm-cod-runtime';
import {codCachePut} from './lm-cod-journeys';
import {codClock,codMoney,parseCodHold} from './lm-cod-workflow';
import {quietCodDecision,type CodIssue,type CodQuietState} from './lm-cod-quiet';
import {resolveBankReminderMentions,resolveRouteMentionNumbers,type MentionRouteConfig} from './lm-dispatch-mentions';
import {bankMentionNumbers,bankReminderText} from './lm-bank-message';
import {bankRemittanceFollowup} from './lm-cod-alerts';
import {codSectionsPng} from './lm-report-image';
import {reportBotDb} from './settings';
export type CodAck={company:string;location:string;day:string;keys:string[];quiet?:Array<{key:string;state:CodQuietState}>};
export async function acknowledgeCodOutput(ack:CodAck){
 for(const key of ack.keys)await codCachePut(ack.company,ack.location,ack.day,key,{sentAt:new Date().toISOString()});
 for(const item of ack.quiet||[])await codCachePut(ack.company,ack.location,ack.day,item.key,item.state);
}
export async function codWorkflowOutputs(company:string,source:{id:string;station_code:string;report_code?:string},day:string,slot:string,route:CodConfig&MentionRouteConfig&{group_id:string},runtime:CodRuntime){
 const report=await loadCodWorkflow(company,source,day,slot,route,runtime),now=Date.now(),db=reportBotDb();
 const cacheKey=(kind:string)=>`quiet:${route.group_id}:${kind}`;
 const keys=['recon','prepare','bank','slip'].map(cacheKey);
 const saved=await db.from('report_bot_cod_route_cache').select('cache_key,payload,expires_at').eq('company_id',company).eq('location_id',source.id).eq('business_date',day).in('cache_key',keys);
 if(saved.error)throw new Error(saved.error.message);
 const prior=new Map<string,CodQuietState>((saved.data||[]).filter(s=>s.payload&&Date.parse(s.expires_at)>now).map(s=>[s.cache_key,s.payload as CodQuietState]));
 // Reset only from explicit source clearance, never because a timing window
 // hid the issue or because a source request failed.
 for(const kind of report.cleared)if(prior.has(cacheKey(kind))){await codCachePut(company,source.id,day,cacheKey(kind),null);prior.delete(cacheKey(kind));}
 if(!report.sections.length&&!report.slips.length&&!report.bankRows.length)return [];
 const groups=await resolveBankReminderMentions(company,[source],route,day);
 const ssa=await resolveRouteMentionNumbers(company,[source],{mentions:[],mention_manager_policy:'none',mention_latest_shift_designation_codes:['SSA']},day);
 const numbers=[...new Set([...bankMentionNumbers(groups),...ssa])];
 const events=await db.from('report_bot_inbound_events').select('sender_jid,text_body,message_at').eq('company_id',company).eq('group_id',route.group_id).eq('from_me',false).gte('message_at',new Date(now-4*3600000).toISOString()).ilike('text_body','COD HOLD %').order('message_at',{ascending:false}).limit(100);
 if(events.error)throw new Error(events.error.message);
 const held=new Set<string>();
 for(const event of events.data||[]){const sender=String(event.sender_jid||'').split('@')[0].split(':')[0];if(!numbers.includes(sender))continue;const hold=parseCodHold(event.text_body||'',source.station_code,Date.parse(event.message_at),now);if(hold)held.add(hold.key);}
 const quietUpdates:Array<{key:string;state:CodQuietState}>=[],escalated=new Set<string>();
 const eligible=(kind:string,issue:CodIssue|undefined,updates=quietUpdates)=>{
  if(held.has(kind))return false;
  if(!issue)return true; // Pickup review / shortfall ledger already have one-time acknowledgements.
  const decision=quietCodDecision(prior.get(cacheKey(kind))||null,issue,now);
  if(!decision.send||!decision.next)return false;
  updates.push({key:cacheKey(kind),state:decision.next});
  if(decision.reason==='escalation')escalated.add(kind);
  return true;
 };
 const sections=report.sections.filter(section=>eligible(section.key,section.issue));
 const bankRows=report.bankRows.length&&eligible('bank',report.bankIssue)?report.bankRows:[];
 const tags=(values:string[])=>values.map(n=>'@'+n).join(' ');
 const owner=[tags(groups.tl),sections.some(s=>s.owner==='team')?tags(ssa):''].filter(Boolean).join(' ')||'Station TL';
 const managers=groups.cluster.length?groups.cluster:groups.aom;
 const fyi=[groups.ct.length?`CT ${tags(groups.ct)}`:'',managers.length?`${groups.cluster.length?'Cluster Manager':'AOM'} ${tags(managers)}`:''].filter(Boolean).join(' · ');
 const title=`${source.station_code} · COD · ${day} · ${slot} IST`;
 const actions=[...new Set(sections.map(s=>s.action))];
 if(bankRows.length){
  const updated=bankRows.some(([key])=>key==='Submitted today');
  actions.push(bankReminderText('',[...bankRows,['Action',bankRemittanceFollowup(updated)]],{...groups,ct:[],cluster:[],aom:[]},true));
  sections.push({key:'bank',title:'Bank remittance',columns:['Status','Value'],rows:bankRows,action:'',owner:'tl',tone:'attention'});
 }
 const outputs:Array<{key:string;body:Record<string,unknown>;codAck:CodAck}>=[];
 if(sections.length){
  const caption=[`*${title}*`,owner,escalated.size?'*Escalation · clearance required.*':'',...actions,quietUpdates.length?'Clear the pending items to stop further alerts.':'',fyi?`FYI: ${fyi}`:''].filter(Boolean).join('\n');
  if(caption.length>3900)throw new Error('COD caption exceeds compact limit; review section size');
  outputs.push({key:`cod_${source.id}`,body:{image_base64:await codSectionsPng(title,sections),mime:'image/png',caption,mentions:[...new Set([...bankMentionNumbers(groups),...(sections.some(s=>s.owner==='team')?ssa:[])])].map(n=>n+'@s.whatsapp.net')},codAck:{company,location:source.id,day,quiet:quietUpdates,keys:[...(held.has('pickup')?[]:report.acks),...(held.has('short')?[]:report.shortAcks)]}});
 }
 const slipUpdates:Array<{key:string;state:CodQuietState}>=[];
 const slips=report.slips.length&&eligible('slip',{ids:report.slips.map(s=>s.code+(s.returned?':returned':'')),amount:report.slips.reduce((n,s)=>n+s.amount,0)},slipUpdates)?report.slips:[];
 if(slips.length){
  const escalation=escalated.has('slip');
  const mentions=[...new Set([...groups.tl,...(escalation?[...groups.ct,...managers]:[])])];
  outputs.push({key:`slip_${source.id}`,body:{text:[`${tags(groups.tl)||'Station TL'} · *${source.station_code} · CMS slip pending*`,escalation?'*Escalation · slip still missing.*':'',...slips.map(s=>`${s.code} · ${codMoney(s.amount)} · submitted ${codClock(s.at)} · ${s.returned?'re-upload required':'slip not uploaded'}`),'Upload the CMS slip in OpsPulse now. Updates stop once uploaded.',escalation&&fyi?`FYI: ${fyi}`:''].filter(Boolean).join('\n'),mentions:mentions.map(n=>n+'@s.whatsapp.net')},codAck:{company,location:source.id,day,quiet:slipUpdates,keys:slips.map(s=>'sent:'+s.key)}});
 }
 return outputs;
}
