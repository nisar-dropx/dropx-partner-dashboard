import {roundMoney} from './now';
export type CfoDay={station:string;name:string;model:string;region:string;city:string;cluster?:string;sourceStation?:string;date:string;unit:'shipments'|'units';volume:number|null;revenue:number|null;cost:number|null;regional:number;da:number;utr:number;van:number;rent:number;other:number;contracts:number;issues:string[]};
export type OverheadLine={station:string;date:string;head:string;name:string;code:string;monthly:number|null;gross:number;alreadyAllocated:number;amount:number;mode:string;recipients:string[];issue?:string};
export type CfoLine={station:string;date:string;head:string;source:string;amount:number;basis:string};
export function totalCfo(rows:CfoDay[],corporate=0){
 const sum=(k:'revenue'|'cost')=>rows.every(r=>r[k]===null)?null:roundMoney(rows.reduce((s,r)=>s+(r[k]??0),0));
 const revenue=sum('revenue'),direct=sum('cost'),regional=roundMoney(rows.reduce((s,r)=>s+r.regional,0));
 const expense=direct===null?null:roundMoney(direct+regional+corporate),profit=revenue===null||expense===null?null:roundMoney(revenue-expense);
 const unitKinds=new Set(rows.map(r=>r.unit)),volume=rows.every(r=>r.volume===null)?null:rows.reduce((s,r)=>s+(r.volume??0),0);
 const directProfit=revenue===null||direct===null?null:roundMoney(revenue-direct);
 return {revenue,direct,regional,corporate,expense,profit,directProfit,directMargin:directProfit!==null&&revenue?100*directProfit/revenue:null,directCpu:unitKinds.size===1&&volume&&direct!==null?direct/volume:null,margin:profit!==null&&revenue?100*profit/revenue:null,volume:unitKinds.size===1?volume:null,unit:unitKinds.size===1?rows[0]?.unit:'mixed',cpu:unitKinds.size===1&&volume&&expense!==null?expense/volume:null,issues:[...new Set(rows.flatMap(r=>r.issues))],through:rows.filter(r=>r.revenue!==null).map(r=>r.date).sort().at(-1)||null};
}
export function profitabilityView(total:ReturnType<typeof totalCfo>,includeOverhead:boolean){
 return {expense:includeOverhead?total.expense:total.direct,profit:includeOverhead?total.profit:total.directProfit,margin:includeOverhead?total.margin:total.directMargin,cpu:includeOverhead?total.cpu:total.directCpu};
}
/** Split to paise, preserving the full group regardless of the report filter. */
export function equalShares(amount:number,codes:string[]){const sorted=[...new Set(codes)].sort(),paise=Math.round(amount*100),base=Math.floor(paise/(sorted.length||1)),remainder=paise-base*sorted.length;return Object.fromEntries(sorted.map((s,i)=>[s,(base+(i<remainder?1:0))/100]));}
export function groupCfo(rows:CfoDay[],by:'station'|'model'|'region'|'city'|'cluster'|'month'|'day'){
 const groups=new Map<string,CfoDay[]>();for(const row of rows){const key=by==='month'?row.date.slice(0,7):by==='day'?row.date:row[by]||'Unassigned';groups.set(key,[...(groups.get(key)||[]),row]);}return [...groups].map(([key,days])=>({key,...totalCfo(days),days}));
}
