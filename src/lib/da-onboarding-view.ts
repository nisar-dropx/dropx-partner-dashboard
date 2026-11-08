import {setupMilestones} from './da-onboarding-setup';
import {workforceAction} from './da-onboarding-policy';
import {daNeedsAttention,type DARow} from './da-onboarding-registry';
import {workforceStage,workforceNeedsAction} from './da-onboarding-policy';
import {facetRows} from './dependent-filters';
export type ScopedDA=DARow&{stationId:string;stationCode:string};
export type DAFilters={query:string;statuses:string[];origins:string[];verification:string[];attention:boolean;workforce?:boolean};
export function daStage(row:DARow){return ['ACTIVE','INACTIVE','OFFBOARDED','CLOSED','ID_NOT_LINKED'].includes(row.status.toUpperCase())?row.status.toUpperCase():'ONBOARDING';}
export function daFacets(rows:ScopedDA[],f:DAFilters){return facetRows(rows,{
 statuses:{selected:f.statuses,values:(r:ScopedDA)=>f.workforce?workforceStage(r).toUpperCase():daStage(r)},
 origins:{selected:f.origins,values:(r:ScopedDA)=>r.origin},
 verification:{selected:f.verification,values:(r:ScopedDA)=>[...setupMilestones(r).filter(m=>m.state!=='complete').map(m=>m.id),...(r.amazon?[r.amazon.bgc?.address?.state||'unknown',...(r.amazon.bgc?.checks.some(c=>c.needsResponse)?['details_needed']:[])]:[])]}
},r=>filterDA([r],{...f,statuses:[],origins:[],verification:[]}).length>0);}
export function filterDA(rows:ScopedDA[],f:DAFilters){const terms=f.query.toLowerCase().trim().split(/\s+/).filter(Boolean);return rows.filter(r=>{
 const searchable=[r.stationCode,r.name,r.email,r.phone,r.owner?.full_name,r.owner?.dropx_id,r.owner?.provider_employee_id,r.amazon?.transporterId,r.amazon?.providerId,r.guided?.driverId,r.origin,r.status,r.next,r.amazon?.bgc?.status,r.amazon?.bgc?.address?.label].join(' ').toLowerCase();
 const v=r.amazon?.bgc?.address?.state||'unknown';
 return terms.every(t=>searchable.includes(t))&&(!f.statuses.length||f.statuses.includes(f.workforce?workforceStage(r).toUpperCase():daStage(r)))&&(!f.origins.length||f.origins.includes(r.origin))&&(!f.verification.length||f.verification.some(s=>setupMilestones(r).some(m=>m.id===s&&m.state!=='complete')||!!r.amazon&&(s===v||(s==='details_needed'&&r.amazon?.bgc?.checks.some(c=>c.needsResponse)))))&&(!f.attention||(f.workforce?workforceNeedsAction(r):daNeedsAttention(r)));
 });}
export function daExportRows(rows:ScopedDA[]){return rows.map(r=>({
 Station:r.stationCode,Name:r.name,Mobile:r.phone||'',Email:r.email||'','DropX ID':r.owner?.dropx_id||'','DropX owner':r.owner?.full_name||'',
 'Provider employee ID':r.owner?.provider_employee_id||'','Amazon transporter ID':r.amazon?.transporterId||r.guided?.driverId||'','Amazon profile ID':r.amazon?.providerId||r.guided?.amazonProfileId||'',
 Status:workforceStage(r),'Account source':r.origin,'Next action':workforceAction(r),'ID mapping':r.setup?.mapping||'Not checked','Rate card':r.setup?.rateCard||'Not checked','Registration status':r.owner?.onboarding_status||r.guided?.registration||'',
 'Onboarding step':r.amazon?.stage||'','Steps completed':r.amazon?.completedSteps??'','Total steps':r.amazon?.totalSteps??'',
 Qualifications:r.amazon?.qualifications||'','Licence expiry':r.amazon?.licenseExpiry||'','BGC status':r.amazon?.bgc?.status||r.guided?.bgc||'Not checked',
 'Address verification':r.amazon?.bgc?.address?.label||'Not checked','IDfy checked at':r.amazon?.bgc?.checkedAt||'',
 'UAN status':r.guided?.uan||'','Learning status':r.guided?.learning||'','Identity review':r.conflict?'Required':'',
 }));}
