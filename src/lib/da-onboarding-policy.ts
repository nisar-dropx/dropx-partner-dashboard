import {linkedAmazonProfiles,type DARow} from './da-onboarding-registry';
export const daDesignationCodes = ['DA','PTDA','DCD','ODCD'] as const;
export function isDADesignation(code:unknown){return daDesignationCodes.includes(String(code).toUpperCase() as typeof daDesignationCodes[number]);}
export type WorkforceQueue='attention'|'onboarding'|'active'|'inactive'|'offboarded';
export const workforceQueues:{id:WorkforceQueue;label:string}[]=[{id:'attention',label:'Needs action'},{id:'onboarding',label:'Onboarding'},{id:'active',label:'Active'},{id:'inactive',label:'Inactive'},{id:'offboarded',label:'Offboarded'}];
/** DropX operational and registration state only. Amazon activation is an independent fact. */
export function workforceStage(row:DARow):Exclude<WorkforceQueue,'attention'>{
 const lifecycle=(row.owner?.lifecycle_status||'').toLowerCase();
 if(['offboarded','closed','exited','cancelled'].includes(lifecycle)||(!row.owner&&row.guided?.closed_at))return 'offboarded';
 if(['inactive','suspended','offboarding','resignation_pending'].includes(lifecycle))return 'inactive';
 if(row.owner?.is_active===false&&row.owner?.onboarding_status==='active')return 'inactive';
 // Legacy profiles keep lifecycle=onboarding even after approved activation. Use the established registration + active flags.
 if(row.owner?.onboarding_status==='active'&&row.owner.is_active===true)return 'active';
 return 'onboarding';
}
export function workforceAction(row:DARow){
 const stage=workforceStage(row),registration=row.owner?.onboarding_status||row.guided?.registration||'pending';
 if(stage==='offboarded')return 'Offboarded · view history';
 if(stage==='inactive')return 'Inactive · review before rejoining';
 if(row.conflict)return 'Review identity link';
 if(row.guided?.inbox_status==='route_failed'||row.guided?.status==='failed')return 'Retry invitation';
 if(['returned','rejected'].includes(registration))return 'Associate: correct returned registration';
 if(['submitted','under_review','approved','confirmed'].includes(registration)&&stage!=='active')return registration==='approved'||registration==='confirmed'?'Team: complete activation review':'Team: review submitted registration';
 if(stage==='onboarding')return 'Associate: complete registration in DropX One';
 if(linkedAmazonProfiles(row).some(a=>a.bgc?.checks.some(c=>c.needsResponse)))return 'Associate: provide requested IDfy information';
 if(linkedAmazonProfiles(row).some(a=>['candidate_pending','information_needed'].includes(a.bgc?.address?.state||'')))return 'Associate: complete address verification';
 if(row.setup?.mapping==='pending')return 'System: waiting for confirmed ID mapping';
 if(row.setup?.rateCard==='pending')return 'Team: configure the rate card';
 if(row.guided?.syncError)return 'Team: check status sync';
 return 'No pending setup action';
}
export function workforceNeedsAction(row:DARow){
 if(['inactive','offboarded'].includes(workforceStage(row)))return false;
 return workforceStage(row)==='onboarding'||row.setup?.mapping==='pending'||row.setup?.rateCard==='pending'||row.conflict||Boolean(row.guided?.syncError)||row.guided?.inbox_status==='route_failed'||row.guided?.status==='failed'||Boolean(linkedAmazonProfiles(row).some(a=>a.bgc?.checks.some(c=>c.needsResponse)))||linkedAmazonProfiles(row).some(a=>['candidate_pending','information_needed'].includes(a.bgc?.address?.state||''));
}
export function inWorkforceQueue(row:DARow,queue:WorkforceQueue){return queue==='attention'?workforceNeedsAction(row):workforceStage(row)===queue;}
