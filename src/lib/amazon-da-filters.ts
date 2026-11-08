import type {AmazonDaPerson, AmazonDaMilestone} from './amazon-da-desk-types';
import {facetRows} from './dependent-filters';

export type DeskPerson = AmazonDaPerson & {stationId?:string;stationCode?:string;requestData?:unknown;pendingMilestones?:string[];milestonesAt?:string|null;verificationWarning?:string|null};
export const addressLabels:Record<string,string>={candidate_pending:'Address · awaiting associate',information_needed:'Address · information needed',review:'Address · in progress',red:'Address · red',verified:'Address · verified',not_requested:'Address · not requested',unknown:'Address · not checked'};
export const humanDesk=(value:string)=>value.replaceAll('_',' ').replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase().replace(/^\w/,c=>c.toUpperCase());
export function needsInformation(p:AmazonDaPerson){return !!p.bgc?.checks?.some(c=>c.needsResponse)||p.bgc?.address?.state==='information_needed';}
export function addressPending(p:AmazonDaPerson){return ['candidate_pending','information_needed','review'].includes(p.bgc?.address?.state||'')||!!p.bgc?.address?.pending;}
export function pendingMilestones(steps:AmazonDaMilestone[]){return [...new Set(steps.flatMap(s=>[...(!/^(completed|complete|done|approved|passed)$/i.test(s.status)?[s.name]:[]),...s.subtasks.filter(t=>!/^(completed|complete|done|approved|passed)$/i.test(t.status)).map(t=>`${s.name} · ${t.name}`)]))];}
export type DeskFilters={query:string;station:string[];status:string[];stage:string[];milestone:string[];address:string[];check:string[];health:string[]};
export const emptyDeskFilters=():DeskFilters=>({query:'',station:[],status:[],stage:[],milestone:[],address:[],check:[],health:[]});
export function checkValues(p:AmazonDaPerson){return [...new Set([p.bgc?.status||'Not checked',...(needsInformation(p)?['Needs information']:[])])];}
export function deskMatchesSearch(p:DeskPerson,query:string){const hay=[p.name,p.transporterId,p.email,p.phone,p.providerId,p.stationCode].join(' ').toLowerCase();return query.toLowerCase().trim().split(/\s+/).every(t=>hay.includes(t));}
export function deskFacets(rows:DeskPerson[],f:DeskFilters){return facetRows(rows,{
 station:{selected:f.station,values:p=>p.stationId||''},
 status:{selected:f.status,values:p=>p.status||'Unknown'},stage:{selected:f.stage,values:p=>p.stage||'Not reported'},
 milestone:{selected:f.milestone,values:p=>p.pendingMilestones?.length?p.pendingMilestones:p.milestonesAt?['No pending milestones']:['Milestones not checked']},
 address:{selected:f.address,values:p=>p.bgc?.address?.state||'unknown'},check:{selected:f.check,values:checkValues},health:{selected:f.health,values:p=>p.health||'Not reported'}
 },p=>deskMatchesSearch(p,f.query));}
export function filterDeskPage(rows:DeskPerson[],f:DeskFilters,view:string,offset:number,snapshot:string,expectedSnapshot:string){
 const all=deskFacets(rows,f).rows;
 const counts={information:all.filter(needsInformation).length,address:all.filter(addressPending).length,all:all.length,unchecked:all.filter(p=>!p.bgc?.address||p.bgc.address.state==='unknown').length};
 const queue=rows.filter(p=>view==='bgc-pending'?needsInformation(p):view==='bgc-address'?addressPending(p):true);
 const faceted=deskFacets(queue,f),matching=faceted.rows;
 const reset=!!expectedSnapshot&&snapshot!==expectedSnapshot;
 const start=reset?0:offset;
 return {rows:matching.slice(start,start+24),total:matching.length,counts,reset,nextOffset:start+24<matching.length?start+24:null,snapshot,
  facets:Object.fromEntries((['station','status','stage','milestone','address','check','health'] as const).map(key=>[key,faceted.values(key).map(value=>({value,label:key==='station'?rows.find(p=>p.stationId===value)?.stationCode||value:key==='address'?addressLabels[value]||humanDesk(value):key==='status'||key==='stage'||key==='health'?humanDesk(value):value}))]))};
}
