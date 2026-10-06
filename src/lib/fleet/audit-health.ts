/** Report calculations shared by the UI, PDF and submission path. */
export type HealthItem = { category: string; weight: number; score: number | null; critical?: boolean };
export function summarizeHealth(items: HealthItem[]) {
 const assessed=items.filter(i=>i.score!==null && i.weight>0);
 const total=assessed.reduce((s,i)=>s+i.weight,0);
 const score=total ? Math.round(assessed.reduce((s,i)=>s+i.weight*i.score!,0)/total) : null;
 const areas=[...new Set(items.map(i=>i.category))].map(category=>{
  const group=assessed.filter(i=>i.category===category), weight=group.reduce((s,i)=>s+i.weight,0);
  return {category,weight,share:total?Math.round(weight/total*100):0,score:weight?Math.round(group.reduce((s,i)=>s+i.weight*i.score!,0)/weight):null,assessed:group.length,total:items.filter(i=>i.category===category).length};
 });
 return {score,areas,assessed:assessed.length,total:items.length,excluded:items.length-assessed.length,critical:items.some(i=>i.critical),weight:total};
}
export type ReportResponse = HealthItem & { itemId: string; label: string; answer: string; comments: string; action: string; days: number | null; passed: boolean | null };
export type ReportFinding = { id: string; auditId: string; itemId: string | null; category: string; finding: string; severity: string; action: string; due: string | null; status: string; resolvedAt: string | null; resolution: string; date: string };
export type Continuity = ReportFinding & { comparison: 'Repeated' | 'Recurred' | 'Pass recorded · closure pending' | 'Not reassessed' | 'Closed'; previousCount: number };
export function compareFindings(previous: ReportFinding[], current: ReportResponse[], asOf: string): Continuity[] {
 const groups=new Map<string,ReportFinding[]>();
 for(const f of previous){const key=f.itemId || `${f.category}:${f.finding.split(':')[0].trim().toLowerCase()}`;groups.set(key,[...(groups.get(key)||[]),f]);}
 return [...groups.values()].map(group=>{
  const ordered=group.sort((a,b)=>b.date.localeCompare(a.date));
  const open=(f:ReportFinding)=>!['resolved','accepted'].includes(f.status) || !!(f.resolvedAt && f.resolvedAt>asOf);
  const f=ordered.find(open)||ordered[0];
  const r=current.find(r=>f.itemId?r.itemId===f.itemId:r.category===f.category&&r.label.trim().toLowerCase()===f.finding.split(':')[0].trim().toLowerCase());
  const comparison=r?.passed===false ? (open(f)?'Repeated':'Recurred') : !open(f)?'Closed':r?.passed===true?'Pass recorded · closure pending':'Not reassessed';
  return {...f,comparison,previousCount:group.length};
 });
}
export type FindingProof = {id:string;url:string;type:string;caption:string;auditId:string};
export type FindingUpdate = {id:string;at:string;actor:string;status:string;note:string;action:string;owner:string;due:string;severity:string;proofs:FindingProof[];before:{status:string;due:string|null;action:string;owner:string;severity:string;resolution?:string}};
export type FindingAction = ReportFinding & {owner:string;updatedAt:string;updates:FindingUpdate[]};
export function findingUrgency(f:ReportFinding,today:string) {
 if(['resolved','accepted'].includes(f.status))return 'Closed';
 if(f.severity==='critical')return 'Immediate';
 if(!f.due)return 'Due date needed';
 if(f.due<today)return 'Overdue';
 if(f.due===today)return 'Due today';
 return f.severity==='high'?'High priority':'Planned';
}
export type AuditReport = {
 id: string; vehicleId:string; vehicleNo:string; model:string; station:string; mode:string; date:string; completedAt:string|null; inspector:string; status:string; summary:string; odometer:number|null;
 score:number|null; scoreBasis:'Weighted health'|'Original checklist score'; health:ReturnType<typeof summarizeHealth>; responses:ReportResponse[]; findings:ReportFinding[]; continuity:Continuity[];
 previous:{id:string;date:string;score:number|null;status:string}[];
 evidence:{id:string;itemId:string|null;type:string;url:string;caption:string;auditId?:string}[]; generatedAt:string;
 actions?:FindingAction[]; canManageActions?:boolean;
};
