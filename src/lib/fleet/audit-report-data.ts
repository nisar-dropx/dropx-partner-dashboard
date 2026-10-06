import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { readAllRows } from '@/lib/supabase-pagination';
import { compareFindings, summarizeHealth, type AuditReport, type ReportFinding, type ReportResponse } from './audit-health';

/** Caller must authorize this audit first. Every query remains company + vehicle scoped. */
export async function loadAuditReport(companyId:string,auditId:string):Promise<AuditReport> {
 const db=supabaseAdmin!;
 const auditResult=await db.from('fleet_audits').select('*,fleet_vehicles!inner(vehicle_no,model,station_code)').eq('company_id',companyId).eq('id',auditId).single();
 if(auditResult.error) throw new Error('Audit report could not be loaded.');
 const a=auditResult.data,v=Array.isArray(a.fleet_vehicles)?a.fleet_vehicles[0]:a.fleet_vehicles;
 const [responses,evidence,history,findings,inspector]=await Promise.all([
  readAllRows(db.from('fleet_audit_responses').select('*,fleet_audit_checklist_items(label,category,sort_order)').eq('company_id',companyId).eq('audit_id',auditId).order('id')),
  readAllRows(db.from('fleet_audit_evidence').select('id,checklist_item_id,media_type,media_url,caption,created_at').eq('company_id',companyId).eq('audit_id',auditId).order('created_at').order('id')),
  readAllRows(db.from('fleet_audits').select('id,scheduled_for,completed_at,status,score').eq('company_id',companyId).eq('vehicle_id',a.vehicle_id).in('status',['passed','failed']).lte('completed_at',a.completed_at||new Date().toISOString()).neq('id',auditId).order('completed_at',{ascending:false}).order('id')),
  readAllRows(db.from('fleet_audit_findings').select('*,fleet_audits!inner(vehicle_id,scheduled_for,completed_at)').eq('company_id',companyId).eq('fleet_audits.vehicle_id',a.vehicle_id).order('created_at').order('id')),
  a.completed_by?db.from('profiles').select('full_name').eq('id',a.completed_by).maybeSingle():Promise.resolve({data:null,error:null})
 ]);
 if([responses,evidence,history,findings].some(r=>r.error)) throw new Error('The complete audit evidence could not be loaded. Please retry.');
 const mapped:ReportResponse[]=(responses.data||[]).sort((x,y)=>(x.fleet_audit_checklist_items?.sort_order||0)-(y.fleet_audit_checklist_items?.sort_order||0)).map(r=>{
  const snapshot=r.response_value||{},item=Array.isArray(r.fleet_audit_checklist_items)?r.fleet_audit_checklist_items[0]:r.fleet_audit_checklist_items;
  const scoring=snapshot.scoring;
  return {itemId:r.checklist_item_id,label:snapshot.label||item?.label||'Checklist response',category:snapshot.category||item?.category||'General',answer:snapshot.config?.options?.find((o:{value:string})=>o.value===snapshot.value)?.label||String(snapshot.value??snapshot.response??''),comments:r.comments||'',action:snapshot.action||'',days:snapshot.days||null,passed:r.passed,weight:scoring?.weight??1,score:scoring ? scoring.score : r.passed===null?null:r.passed?100:0,critical:scoring?.critical||false};
 });
 const priorIds=new Set((history.data||[]).map(h=>h.id));
 const allFindings:ReportFinding[]=(findings.data||[]).map(f=>({id:f.id,auditId:f.audit_id,itemId:f.checklist_item_id,category:f.category,finding:f.finding,severity:f.severity,action:f.action_required||'',due:f.expected_completion_date,status:f.status,resolvedAt:f.resolved_at,resolution:f.resolution_note||'',date:f.fleet_audits?.scheduled_for||f.created_at.slice(0,10)}));
 const currentFindings=allFindings.filter(f=>f.auditId===auditId);
 const relevant=allFindings.filter(f=>f.auditId===auditId||priorIds.has(f.auditId));
 const updates=relevant.length?await readAllRows(db.from('fleet_audit_finding_updates').select('*').eq('company_id',companyId).in('finding_id',relevant.map(f=>f.id)).order('created_at').order('id')):{data:[],error:null};
 if(updates.error)throw new Error('Action history could not be loaded. Please retry.');
 const ownerIds=[...new Set((findings.data||[]).map(f=>f.owner_user_id).filter(Boolean))];
 const owners=ownerIds.length?await db.from('profiles').select('id,full_name').eq('company_id',companyId).in('id',ownerIds):{data:[],error:null};
 if(owners.error)throw new Error('Action owners could not be loaded. Please retry.');
 const actions=relevant.map(f=>{
  const raw=findings.data!.find(r=>r.id===f.id)!;
  return {...f,owner:raw.responsible_name||owners.data?.find(o=>o.id===raw.owner_user_id)?.full_name||'',updatedAt:raw.updated_at,
   updates:(updates.data||[]).filter(u=>u.finding_id===f.id).map(u=>({id:u.id,at:u.created_at,actor:u.actor_name,status:u.status,note:u.note,action:u.action_required,owner:u.responsible_name,due:u.due_date,severity:u.severity,
    before:{resolution:u.before_state.resolution_note||'',status:u.before_state.status,due:u.before_state.expected_completion_date,action:u.before_state.action_required||'',owner:u.before_state.responsible_name||'',severity:u.before_state.severity},
    proofs:(u.proofs||[]).map((p:{id:string;path:string;type:string;caption:string})=>({id:p.id,url:`/api/fleet/audit-evidence?path=${encodeURIComponent(p.path)}`,type:p.type,caption:p.caption,auditId:f.auditId}))}))};
 });
 const health=summarizeHealth(mapped);health.critical ||= currentFindings.some(f=>f.severity==='critical');
 return {actions,id:a.id,vehicleId:a.vehicle_id,vehicleNo:v.vehicle_no,model:v.model||'',station:v.station_code,mode:/^\[mode:video\]/i.test(a.scheduled_reason||'')?'Virtual review':'Physical inspection',date:a.scheduled_for,completedAt:a.completed_at,inspector:inspector.data?.full_name||'Not recorded',status:a.status,summary:a.summary||'',odometer:a.odometer_km,score:a.score==null?null:Number(a.score),scoreBasis:(responses.data||[]).some(r=>r.response_value?.scoring?.version===1)?'Weighted health':'Original checklist score',health,responses:mapped,findings:currentFindings,continuity:compareFindings(allFindings.filter(f=>priorIds.has(f.auditId)),mapped,a.completed_at||new Date().toISOString()),previous:(history.data||[]).map(h=>({id:h.id,date:h.scheduled_for,score:h.score==null?null:Number(h.score),status:h.status})),evidence:(evidence.data||[]).map(e=>({id:e.id,itemId:e.checklist_item_id,type:e.media_type,url:e.media_url,caption:e.caption||''})),generatedAt:new Date().toISOString()};
}
