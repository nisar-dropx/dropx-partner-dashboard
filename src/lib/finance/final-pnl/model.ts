export interface EntryDetail {date:string;paise:number;reference:string;label:string;}
export interface Entry {
 id:string;month:string;station:string;sourceStation:string;side:'income'|'expense';head:string;description:string;paise:number;
 source:string;reference:string;date:string;recovery?:boolean;caseKey?:string;payrollMonth?:string;
 details?:EntryDetail[];
 version?:number;modified?:boolean;sourceChanged?:boolean;sourceHash?:string;deleted?:boolean;
}
export interface Loss {id:string;month:string;station:string;reference:string;paise:number;outcome:string;plannedPaise:number;payrollMonth:string;responsible:string;postedPaise:number;evidence:string;}
export interface Schedule {id:string;month:string;caseKey:string;station:string;payrollMonth:string;paise:number;responsible:string;note:string;version?:number;deleted?:boolean;}
export interface Dimension {code:string;name:string;region:string;state:string;model:string;format?:string;cluster:string;managers:string[];isHo:boolean;}
export function reportingState(value:unknown):string {
 const state=String(value??'').trim();
 const known:Record<string,string>={AP:'Andhra Pradesh','ANDHRA PRADESH':'Andhra Pradesh',KL:'Kerala',KERALA:'Kerala',OD:'Odisha',OR:'Odisha',ODISHA:'Odisha',ORISSA:'Odisha',CG:'Chhattisgarh',CHHATTISGARH:'Chhattisgarh',KA:'Karnataka',KARNATAKA:'Karnataka',TS:'Telangana',TG:'Telangana',TELANGANA:'Telangana',UP:'Uttar Pradesh','UTTAR PRADESH':'Uttar Pradesh',TN:'Tamil Nadu','TAMIL NADU':'Tamil Nadu'};
 return known[state.toUpperCase()]??(state||'Unassigned');
}
export interface OverheadRule {station_code:string;mode:'regional'|'corporate';recipient_codes:string[];allocation?:'equal'|'revenue'|'custom';weights?:Record<string,number>;effective_from:string;effective_to?:string|null;version?:number;}
export interface OverheadPool {code:string;entries:Entry[];rule:OverheadRule|null;total:number;allocated:number;unallocated:number;income:number;issue:string;allocations:Entry[];}
export interface Sources {
 dimensions?:Dimension[];overheadRules?:OverheadRule[];company:string;month:string;capturedAt:string;stations:{code:string;base:string;aliases:string[];active?:boolean;isHo?:boolean;hidden?:boolean}[];entries:Entry[];losses:Loss[];issues:string[];counts:Record<string,number>;}
export interface Report {
 overheadPools?:OverheadPool[];excludedInactiveEntries?:number;
 dimensions?:Dimension[];
 month:string;entries:Entry[];schedules:Schedule[];losses:Loss[];stations:string[];issues:string[];capturedAt:string|null;counts:Record<string,number>;
 totals:{income:number;expense:number;profit:number;recovery:number;gst:number};
 invoices:{key:string;month:string;station:string;reference:string;date:string;taxPaise:number;totalPaise:number;issues:string[]}[];
 audit:{sequence:number;entry_id:string;kind:string;action:string;actor:string;reason:string;at:string;before_json:string|null;after_json:string}[];
 ingest:{runId:string;at:string;documents:number;problems:string[]}|null;
}
export function monthValue(value:unknown):string{
 if(typeof value!=='string'||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(value))throw Error('Choose a valid month.');return value;
}
export function paise(value:unknown):number{const n=Number(value);if(value===null||value===undefined||!Number.isFinite(n)||Math.abs(n)>1e10)throw Error('Invalid financial amount in source.');return Math.round(n*100);}
export function money(value:number){return new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(value/100);}
export function previousMonth(now=new Date()){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit'}).formatToParts(now);const y=Number(parts.find(p=>p.type==='year')!.value),m=Number(parts.find(p=>p.type==='month')!.value);return `${m===1?y-1:y}-${String(m===1?12:m-1).padStart(2,'0')}`;}
export function monthEnd(month:string){monthValue(month);const [year,m]=month.split('-').map(Number);return new Date(Date.UTC(year!,m!,0)).toISOString().slice(0,10);}
export function baseStations(stations:{id:string;station_code:string;parent_station_id:string|null}[],aliases:{location_id:string;portal_station_code:string|null}[]){
 const byId=new Map(stations.map(s=>[s.id,s]));
 return stations.map(s=>{let base=s;const seen=new Set([s.id]);while(base.parent_station_id){const parent=byId.get(base.parent_station_id);if(!parent)throw Error(`Missing parent for ${s.station_code}`);if(seen.has(parent.id))throw Error('Station hierarchy contains a cycle.');seen.add(parent.id);base=parent;}
  return {code:s.station_code,base:base.station_code,aliases:aliases.filter(a=>a.location_id===s.id&&a.portal_station_code).map(a=>a.portal_station_code!)};
 });
}
export function latestPublications(rows:Record<string,any>[],personKey:string){
 const seen=new Set<string>();return [...rows].sort((a,b)=>Number(b.revision)-Number(a.revision)||String(b.published_at).localeCompare(String(a.published_at))).filter(row=>{const key=[row[personKey],row.station_id,row.period_start,row.period_end].join(':');if(seen.has(key))return false;seen.add(key);return true;});
}
export function csvCell(value:unknown){if(typeof value==='number'&&Number.isFinite(value))return String(value);const text=String(value??'');return '"'+(/^[=+@\-\t\r]/.test(text)?"'"+text:text).replaceAll('"','""')+'"';}

export function recoveryRecognitionMonth(payrollPeriod:string|null|undefined,postingDate:string,salaryDeduction:boolean){return monthValue((salaryDeduction?payrollPeriod:postingDate)?.slice(0,7));}
