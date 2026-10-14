import { auditQueueBucket, addAuditDays } from './station-audit-planning';
import type { CodPendingRow } from './cod-pending';

export type AttentionItem = { key:string; title:string; value:string; detail:string; href:string; action:string; tone:'urgent'|'action'|'unknown'|'clear'; count?:number; dueAt?:string };
export function attentionOrder(items:AttentionItem[]) {
  const rank={urgent:0,action:1,unknown:2,clear:3};
  const order=['audits','cod','cms','people','vehicles','payments','rosters','capacity','documents'];
  const due=(i:AttentionItem)=>i.dueAt&&Number.isFinite(Date.parse(i.dueAt))?Date.parse(i.dueAt):Infinity;
  return [...items].sort((a,b)=>rank[a.tone]-rank[b.tone]||due(a)-due(b)||(b.count??0)-(a.count??0)||order.indexOf(a.key)-order.indexOf(b.key)||a.key.localeCompare(b.key));
}
export function codAttention(rows:CodPendingRow[],date:string,canReport:boolean):AttentionItem[] {
  const missing=rows.filter(r=>r.status==='Missing slip'||r.status==='Slip missing proof');
  const corrections=rows.filter(r=>r.pending&&!missing.includes(r));
  const cms=rows.filter(r=>!r.entries.length&&r.exception?.kind==='Banker Not Reported');
  const review=rows.filter(r=>!r.pending&&['Review pending','Pending verification'].includes(r.status));
  const link=(r:CodPendingRow|undefined,status:string)=>canReport
    ? `/ops-pulse/cod/pending?${new URLSearchParams({date,status,...(r?{location:r.station.id}:{})})}`
    : `/ops-pulse/cod/submission?${new URLSearchParams({deposit_date:date,...(r?{location:r.station.id,client:r.client}:{})})}`;
  const items:AttentionItem[]=[{key:'cod',title:'COD slips',value:`${missing.length} missing uploads`,count:missing.length,
    detail:`${date} · ${missing.filter(r=>r.overdue).length} overdue · No Cash / banker exceptions excluded`,
    href:link(missing[0],'pending'),action:missing[0]?`Open ${missing[0].station.station_code} slip`:'Open slip workspace',
    dueAt:missing[0]?.deadline,tone:missing.some(r=>r.overdue)?'urgent':missing.length?'action':'clear'},
    {key:'cms',title:'CMS / banker follow-up',value:`${cms.length} not reported`,count:cms.length,
    detail:`${date} · recorded banker-not-reported exceptions, not staff attendance`,
    href:link(cms[0],'Banker Not Reported'),action:cms[0]?`Open ${cms[0].station.station_code} update`:'Open daily updates',tone:cms.length?'action':'clear'}];
  if(corrections.length||review.length)items.push({key:'cod-review',title:'COD review',value:`${corrections.length+review.length} stations`,count:corrections.length+review.length,
    detail:`${corrections.length} need corrections · ${review.length} awaiting verification · ${date}`,
    href:link(corrections[0]||review[0],'all'),action:'Review slips',tone:corrections.some(r=>r.overdue)?'urgent':'action'});
  return items;
}
export function auditAttention(rows:{scheduled_for:string;status_code:string;completed_at?:string|null;station_response_status?:string;response_due_at?:string|null}[],today:string,now:number) {
  const open=rows.filter(r=>r.status_code!=='closed');
  const buckets=open.map(r=>auditQueueBucket(r,today));
  const lateResponses=open.filter(r=>r.completed_at&&r.station_response_status==='requested'&&r.response_due_at&&Date.parse(r.response_due_at)<now).length;
  const overdue=buckets.filter(b=>b==='overdue').length+lateResponses;
  const due=buckets.filter(b=>b==='today').length;
  const followup=buckets.filter(b=>b==='followup').length;
  const upcoming=buckets.filter(b=>b==='next2'||b==='week').length;
  return {overdue,due,followup,upcoming,action:open.filter((r,i)=>['overdue','today','followup'].includes(buckets[i])).length};
}
export type AttentionDocument={document_type_id:string;scope_type:string;scope_id:string|null;additional_scope_ids?:string[]|null;expiry_date:string|null;track_expiry?:boolean|null;document_types?:{doc_access_mode:string|null}|{doc_access_mode:string|null}[]|null};
// Only location documents appear here. Broader company/state records remain in Business Docs.
// Keep the same role restriction as that workspace; failure to load role rules must fail closed.
export function documentAttention(rows:AttentionDocument[],roleRules:{document_type_id:string;role_id:string}[],ids:string[],roleId:string|null,all:boolean,today:string) {
  const selected=new Set(ids),end=addAuditDays(today,30);
  const visible=rows.filter(r=>{
    if(r.scope_type!=='location'||![r.scope_id,...r.additional_scope_ids??[]].some(id=>id&&selected.has(id)))return false;
    const type=Array.isArray(r.document_types)?r.document_types[0]:r.document_types;
    const roles=roleRules.filter(x=>x.document_type_id===r.document_type_id).map(x=>x.role_id);
    return all||type?.doc_access_mode!=='role_based'||!roles.length||Boolean(roleId&&roles.includes(roleId));
  }).filter(r=>r.track_expiry!==false&&r.expiry_date&&r.expiry_date<=end);
  return {expired:visible.filter(r=>r.expiry_date!<today).length,soon:visible.filter(r=>r.expiry_date!>=today).length};
}
