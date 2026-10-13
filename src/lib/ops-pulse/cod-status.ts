import type { PickupPolicy } from './cod-pickup';
import { reconciliationView } from './cod-reconciliation.ts';
export type CodStatusLocation = { id: string; code: string; name: string; model: string; region: string; manager: string; managers?: string[]; managerRole?: 'Cluster' | 'AOM' | 'Unmapped'; pickup?: PickupPolicy | null; reconDueTime?: string | null };
export type StatusComponent<T> = { state: 'ok' | 'unavailable'; checkedAt: string; data: T | null };
export type CodRemittance = { id: string; code: string | null; status: string; expectedAmount: number; actualAmount: number; variance: number; createdAt: number | null; updatedAt: number | null; submittedAt: number | null; createdBy: string; submittedBy: string | null };
export type CodStatusSnapshot = {
  version: 1; stationCode: string; date: string; fetchedAt: string; cached?: boolean;
  remittanceWindow: { startTime: number; endTime: number };
  reconciliation: StatusComponent<{ complete: boolean; driverCount: number; pendingCount: number; pendingAmount: number; completedPercent: number; drivers: { id: string; name: string; pendingAmount: number; packages: { trackingId: string; amount: number; paymentMethod: string; collectedAt?: number | null; transactionAt?: number | null }[] }[] }>;
  prepareDeposit: StatusComponent<{ expectedAmount: number; actualAmount: number; variance: number }>;
  remittances: StatusComponent<{ complete: boolean; openCount: number; openAmount: number; submittedToday: boolean; latestSubmitted: CodRemittance | null; rows: CodRemittance[] }>;
};
export function codStatusToday(now = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year:'numeric',month:'2-digit',day:'2-digit' }).format(now); }
export type CodTone = 'attention' | 'active' | 'waiting' | 'clear' | 'unavailable' | 'unchecked';
export type CodPart = 'reconciliation' | 'prepareDeposit' | 'remittances';
export type CodCheck = { tone: CodTone; label: string; reason: string };
export type RemittanceCheck = CodCheck & { id: string; dueAt?: number };
export const codToneLabels: Record<CodTone,string> = {attention:'Needs action', active:'Today · in progress', waiting:'Awaiting pickup / preparation', clear:'Complete / clear', unavailable:'Needs verification', unchecked:'Not checked'};
const timestamp = (n: number | null | undefined): n is number => Number.isFinite(n) && Number(n) > 0;
const timeIst = (n: number) => new Date(n + 330 * 60000).toISOString().slice(11,16);
const dayAt = (day: string, time: string) => Date.parse(`${day}T${time}:00+05:30`);
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0,10);
const submittedTime = (r: CodRemittance | null) => r && (timestamp(r.submittedAt) ? r.submittedAt : timestamp(r.updatedAt) ? r.updatedAt : null);
const isOpen = (r: CodRemittance) => ['CREATED','PENDING_SUBMISSION'].includes(r.status.toUpperCase());
const unknown = (reason: string): CodCheck => ({tone:'unavailable',label:'Needs verification',reason});

/** People hierarchy is authoritative. Fall back to AOM only when no cluster is mapped. */
export function codStatusOwner(row: {cluster_manager_names?: string[]; aom_names?: string[]}) {
  const clusters = (row.cluster_manager_names || []).map(n=>n.trim()).filter(Boolean);
  const aoms = (row.aom_names || []).map(n=>n.trim()).filter(Boolean);
  const managers = [...new Set(clusters.length ? clusters : aoms)];
  return {manager:managers.join(', '), managers, managerRole:(clusters.length ? 'Cluster' : aoms.length ? 'AOM' : 'Unmapped') as 'Cluster'|'AOM'|'Unmapped'};
}
/** Raw portal records are retained. Earlier creation is a timing comparison,
 * never a claim that an open record has been closed or bank-settled. */
export function classifyRemittance(row: CodRemittance, latest: CodRemittance | null, policy: PickupPolicy | null, now = new Date()): RemittanceCheck {
  const base = {id:row.id};
  if (!isOpen(row)) return {...base, ...unknown('This record is not an open remittance.')};
  const created = row.createdAt, submitted = submittedTime(latest);
  if (!timestamp(created) || created > now.getTime()) return {...base,...unknown('Creation time is missing or invalid.')};
  if (timestamp(submitted) && submitted <= now.getTime() && created <= submitted) return {...base,tone:'clear',label:'Before latest submission',reason:'Created before a later submitted remittance. No new-deposit timing alert; the original portal status is retained below.'};
  if (!policy) return {...base,...unknown('Configure this station in COD Pickup Master to validate timing.')};
  const date = codStatusToday(new Date(created)), clock = timeIst(created);
  let dueDate = date;
  if (policy.rule === 'Next Day') {
    if (!policy.preparationFrom) return {...base,...unknown('Set the next-day preparation time in COD Pickup Master.')};
    if (clock >= policy.preparationFrom) dueDate = nextDay(date);
    else if (timestamp(submitted) && submitted < created && codStatusToday(new Date(submitted)) === date) {
      return {...base,tone:'attention',label:'Prepared before allowed time',reason:`Created after that day’s submission but before ${policy.preparationFrom} IST. Review this daytime preparation.`};
    }
    // Preparation before the evening cutoff belongs to that day's pickup.
  } else if (policy.rule === 'Same Day-Partial' && clock > policy.end) dueDate = nextDay(date);
  const dueAt = dayAt(dueDate,policy.end);
  return now.getTime() > dueAt
    ? {...base,dueAt,tone:'attention',label:'Pickup overdue',reason:`Open beyond pickup on ${dueDate}, ${policy.start}–${policy.end} IST.`}
    : {...base,dueAt,tone:'waiting',label:'Awaiting scheduled pickup',reason:`Due ${dueDate}, ${policy.start}–${policy.end} IST. Within the station’s pickup schedule.`};
}
export function codStatusChecks(snapshot: CodStatusSnapshot | undefined, policy: PickupPolicy | null = null, now = new Date(), failed = false, collectionDate='', reconDueTime:string|null=null): Record<CodPart,CodCheck> {
  if (!snapshot) { const c:CodCheck = failed ? unknown('Refresh this station to retry.') : {tone:'unchecked',label:'Not checked',reason:'Waiting for the station check.'}; return {reconciliation:c,prepareDeposit:c,remittances:c}; }
  if (failed || snapshot.date !== codStatusToday(now) || !Number.isFinite(Date.parse(snapshot.fetchedAt)) || now.getTime()-Date.parse(snapshot.fetchedAt)>15*60000) {
    const c=unknown('Previous check · refresh required');return {reconciliation:c,prepareDeposit:c,remittances:c};
  }
  const r=snapshot.reconciliation.state==='ok'?snapshot.reconciliation.data:null;
  const p=snapshot.prepareDeposit.state==='ok'?snapshot.prepareDeposit.data:null;
  const m=snapshot.remittances.state==='ok'?snapshot.remittances.data:null;
  const reconciliation = reconciliationView(r,collectionDate,reconDueTime,now).check;
  const prepareDeposit:CodCheck = !p ? unknown('Prepare Deposit could not be verified.') : Math.abs(p.variance)>=0.01 ? {tone:'attention',label:'Cash difference',reason:'Expected and actual cash differ.'} : [p.expectedAmount,p.actualAmount].some(n=>Math.abs(n)>=0.01) ? {tone:'waiting',label:'Cash to prepare',reason:'Cash is waiting for preparation; its collection age is not supplied by this overview.'} : {tone:'clear',label:'Zero balance',reason:'No cash waiting to be prepared.'};
  let remittances:CodCheck;
  if (!m) remittances=unknown('Remittances could not be verified.');
  else {
    const open=m.rows.filter(isOpen), checks=open.map(row=>classifyRemittance(row,m.latestSubmitted,policy,now));
    const alerts=checks.filter(c=>c.tone==='attention'), waiting=checks.filter(c=>c.tone==='waiting');
    if (alerts.length) remittances={tone:'attention',label:`${alerts.length} timing ${alerts.length===1?'issue':'issues'}`,reason:alerts[0].reason};
    else if (!m.complete || open.length!==m.openCount || checks.some(c=>c.tone==='unavailable')) remittances=unknown('Some remittance records or pickup settings need verification.');
    else if (waiting.length) remittances={tone:'waiting',label:`${waiting.length} awaiting pickup`,reason:waiting.sort((a,b)=>(a.dueAt||0)-(b.dueAt||0))[0].reason};
    else if (open.length) remittances={tone:'clear',label:'No new deposit pending',reason:`${open.length} earlier open ${open.length===1?'record predates':'records predate'} the latest submission. View original records below.`};
    else remittances={tone:'clear',label:m.submittedToday?'Submitted today':'No open remittance',reason:m.submittedToday?'A submitted remittance was updated today.':'No open remittance in the checked portal window.'};
  }
  return {reconciliation,prepareDeposit,remittances};
}
export function codStatusCategory(snapshot: CodStatusSnapshot | undefined, now = new Date(), policy: PickupPolicy | null = null, failed = false, collectionDate='', reconDueTime:string|null=null): CodTone {
  const checks=Object.values(codStatusChecks(snapshot,policy,now,failed,collectionDate,reconDueTime));
  return (['attention','unavailable','unchecked','waiting','active','clear'] as CodTone[]).find(t=>checks.some(c=>c.tone===t))!;
}
export type CodFilters = {search?:string;model?:string;region?:string;manager?:string;overall?:string;reconciliation?:string;prepareDeposit?:string;remittances?:string};
export function matchesCodFilters(location:CodStatusLocation, checks:Record<CodPart,CodCheck>, overall:CodTone, filters:CodFilters) {
  return (!filters.search || `${location.code} ${location.name}`.toLowerCase().includes(filters.search.trim().toLowerCase()))
    && (!filters.model || location.model===filters.model)
    && (!filters.region || (location.region || '__unmapped')===filters.region)
    && (!filters.manager || (filters.manager==='__unmapped' ? !location.manager : (location.managers || [location.manager]).includes(filters.manager)))
    && (!filters.overall || overall===filters.overall)
    && (['reconciliation','prepareDeposit','remittances'] as const).every(part=>!filters[part] || checks[part].tone===filters[part]);
}
export type CodSort = 'station'|'region'|'manager'|'reconciliation'|'prepareDeposit'|'remittances'|'checkedAt';
export function compareCodRows(a:CodStatusLocation,b:CodStatusLocation,snapshots:Record<string,CodStatusSnapshot|undefined>, sort:CodSort, direction:'asc'|'desc', now:Date, collectionDate='') {
  const value=(l:CodStatusLocation):string|number|null=>{
    const s=snapshots[l.id];
    if(sort==='station') return l.code;
    if(sort==='region') return l.region || null;
    if(sort==='manager') return l.manager || null;
    if(sort==='checkedAt') return s && Number.isFinite(Date.parse(s.fetchedAt)) ? Date.parse(s.fetchedAt) : null;
    if(sort==='reconciliation') return s?.reconciliation.data ? reconciliationView(s.reconciliation.data,collectionDate,l.reconDueTime || null,now).amount : null;
    if(sort==='prepareDeposit') return s?.prepareDeposit.data?.expectedAmount ?? null;
    return s ? ['attention','waiting','unavailable','unchecked','clear'].indexOf(codStatusChecks(s,l.pickup || null,now).remittances.tone) : null;
  };
  const av=value(a),bv=value(b);
  // Missing values stay last in either direction; station code is a stable tie-break.
  if(av===null || bv===null) return av===bv ? a.code.localeCompare(b.code) : av===null ? 1 : -1;
  const result=typeof av==='number' && typeof bv==='number' ? av-bv : String(av).localeCompare(String(bv));
  return (direction==='asc'?result:-result) || a.code.localeCompare(b.code);
}
