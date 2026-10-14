import { auditQueueBucket, addAuditDays } from './station-audit-planning';

export type AttentionItem = { key:string; title:string; value:string; detail:string; href:string; action:string; tone:'urgent'|'action'|'unknown'|'clear' };
export function attentionOrder(items:AttentionItem[]) {
  const rank={urgent:0,action:1,unknown:2,clear:3};
  const order=['audits','people','cod','vehicles','payments','rosters','capacity','documents'];
  return [...items].sort((a,b)=>rank[a.tone]-rank[b.tone]||order.indexOf(a.key)-order.indexOf(b.key));
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
