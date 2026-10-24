import type {CfoDay,OverheadLine} from './cfo';
import type {OverheadRule} from './now';

type Location={station_code:string;state?:string|null;region?:string|null;is_ho?:boolean|null;hide_from_location_list?:boolean|null};
const family=(model:string)=>model.startsWith('Amazon Now ')?'Amazon Now':model;
const stateCodes:Record<string,string>={KERALA:'KL','ANDHRA PRADESH':'AP',ODISHA:'OD',ORISSA:'OD',CHHATTISGARH:'CG','TAMIL NADU':'TN',TELANGANA:'TS','UTTAR PRADESH':'UP'};
/** Cumulative paise rounding conserves refunds as well as positive costs. */
export function weightedShares(amount:number,weights:Record<string,number>){
 const keys=Object.keys(weights).sort(),denominator=keys.reduce((n,k)=>n+Math.max(0,weights[k]),0);
 if(!denominator)return {} as Record<string,number>;
 let cumulative=0,previous=0;return Object.fromEntries(keys.map(key=>{cumulative+=Math.max(0,weights[key]);const end=Math.round(Math.round(amount*100)*cumulative/denominator),share=(end-previous)/100;previous=end;return [key,share];}));
}
export function regionalPolicy(station:string,date:string,locations:Location[],rules:OverheadRule[]){
 if(['HO_CLT','HO_MJR'].includes(station))return {mode:'corporate',recipients:[] as string[]};
 const suffix=station.replace(/^HO_/,''),known=['KL','AP','OD','CG','TN','TS','UP'].includes(suffix);
 const recipients=known?locations.filter(l=>!l.is_ho&&!l.hide_from_location_list&&(stateCodes[String(l.state??'').trim().toUpperCase()]??String(l.state??'').trim().toUpperCase())===suffix).map(l=>l.station_code):rules.filter(r=>r.station_code===station&&r.effective_from<=date&&(!r.effective_to||r.effective_to>=date)).sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0]?.recipient_codes??[];
 return {mode:recipients.length?'regional':'unallocated',recipients:[...new Set(recipients)].sort()};
}
/** Weights use the full loaded reporting month, never the user's display filter. */
export function regionalShares(line:OverheadLine,days:CfoDay[]){
 const month=line.date.slice(0,7),eligible=days.filter(d=>d.date.startsWith(month)&&line.recipients.includes(d.sourceStation||d.station));
 const now=eligible.length>0&&eligible.every(d=>d.unit==='units'),basis=now?'revenue':'delivered volume';
 const missing=line.recipients.filter(code=>!eligible.some(d=>(d.sourceStation||d.station)===code&&(now?d.revenue:d.volume)!==null));
 if(missing.length)return {shares:{} as Record<string,number>,basis,issue:`Missing ${basis} for ${missing.join(', ')}; HO retained as unallocated.`};
 if(!now&&eligible.some(d=>d.unit==='units'))return {shares:{} as Record<string,number>,basis,issue:'Mixed shipment and Amazon Now recipients require separate regional HO pools.'};
 const weights:Record<string,number>={};for(const d of eligible){const key=d.sourceStation||d.station;weights[key]=(weights[key]||0)+Math.max(0,(now?d.revenue:d.volume)??0);}
 const shares=weightedShares(line.amount,weights);
 return {shares,basis,issue:Object.keys(shares).length?'':`No positive ${basis}; HO retained as unallocated.`};
}
export type CorporateShare={model:string;month:string;amount:number;revenue:number};
export function corporateShares(days:CfoDay[],overhead:OverheadLine[]){
 const shares:CorporateShare[]=[],issues:string[]=[];
 for(const month of [...new Set(overhead.filter(o=>o.mode==='corporate').map(o=>o.date.slice(0,7)))]){
  const rows=days.filter(d=>d.date.startsWith(month)),models=[...new Set(rows.map(d=>family(d.model)))],weights:Record<string,number>={};
  const missing=models.filter(model=>!rows.some(d=>family(d.model)===model&&d.revenue!==null));
  if(missing.length){issues.push(`${month}: corporate HO remains separate because revenue is unavailable for ${missing.join(', ')}.`);continue;}
  for(const d of rows){const key=family(d.model);weights[key]=(weights[key]||0)+(d.revenue??0);}
  const total=overhead.filter(o=>o.mode==='corporate'&&o.date.startsWith(month)).reduce((n,o)=>n+o.amount,0),split=weightedShares(total,weights);
  if(!Object.keys(split).length&&total)issues.push(`${month}: corporate HO remains separate because there is no positive revenue.`);
  for(const [model,amount] of Object.entries(split))shares.push({model,month,amount,revenue:weights[model]});
 }
 return {shares,issues};
}
