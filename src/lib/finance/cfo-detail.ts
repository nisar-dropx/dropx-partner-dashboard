import {pnlTotal,type PnlDay} from './pnl';
import {groupCfo,type CfoDay,type OverheadLine} from './cfo';
export const modelFamily=(model:string)=>model.startsWith('Amazon Now ')?'Amazon Now':model;
export function filterCfoDays(days:CfoDay[],filters:{model:string;region:string;cluster:string;station:string}){
 return days.filter(d=>(!filters.model||modelFamily(d.model)===filters.model)&&(!filters.region||d.region===filters.region)&&(!filters.cluster||(d.cluster||'Unassigned')===filters.cluster)&&(!filters.station||d.station===filters.station));
}
export function evidenceRows(days:CfoDay[]):PnlDay[]{return days.map(d=>({station:d.sourceStation||d.station,name:d.name,region:d.region,date:d.date,revenue:d.revenue,cost:d.cost,deliveries:d.volume,base:null,variable:null,swa:null,mfn:null,da:d.da,utr:d.utr,van:d.van,rent:d.rent,other:d.other,issues:d.issues}));}
export function chartReport(days:CfoDay[],overhead:OverheadLine[],includeCorporate:boolean,includeRegional=true){
 const rows=evidenceRows(days).map((d,i)=>({...d,cost:d.cost===null?null:d.cost+(includeRegional?days[i].regional:0),other:d.other+days[i].contracts+(includeRegional?days[i].regional:0)}));
 const corporate=includeCorporate?overhead.filter(o=>['corporate','unallocated'].includes(o.mode)):[];
 const total=pnlTotal(rows),corp=corporate.reduce((s,o)=>s+o.amount,0);
 if(total.cost!==null){total.cost+=corp;total.profit=total.revenue===null?null:total.revenue-total.cost;total.other+=corp;}
 const dates=[...new Set([...rows.map(r=>r.date),...corporate.map(o=>o.date)])].sort();
 const daily=dates.map(date=>{const day=pnlTotal(rows.filter(d=>d.date===date),date),cost=corporate.filter(o=>o.date===date).reduce((s,o)=>s+o.amount,0);if(day.cost!==null||cost){day.cost=(day.cost||0)+cost;day.profit=day.revenue===null?null:day.revenue-day.cost;}return day;});
 const sum=(key:'da'|'utr'|'van'|'rent'|'other'|'contracts'|'regional')=>days.reduce((s,d)=>s+d[key],0);
 return {total,daily,costItems:[{label:'Delivery associates',value:sum('da'),color:'#3578cb'},{label:'Station / store team',value:sum('utr'),color:'#8b66c4'},{label:'Vehicles & fuel',value:sum('van'),color:'#168777'},{label:'Rent & maintenance',value:sum('rent'),color:'#c78635'},{label:'Other operating costs',value:sum('other'),color:'#718391'},{label:'Outsourced contracts',value:sum('contracts'),color:'#ce7eaa'},...(includeRegional?[{label:'Regional overhead',value:sum('regional'),color:'#83a94a'}]:[]),...(includeCorporate?[{label:'Central / unallocated HO',value:corp,color:'#233e52'}]:[])]};
}
/** Keep client-side filtering instant, while making reloads and date changes reproducible. */
export function cfoViewHref(dates:{period:string;month:string;from:string;to:string},filters:{model:string;region:string;cluster:string;station:string},includeOverhead:boolean){
 const params=new URLSearchParams({...dates,model:filters.model,region:filters.region,cluster:filters.cluster,location:filters.station,overhead:includeOverhead?'1':'0'});
 return '/finance/profitability?'+params.toString();
}
export function cfoComparison(days:CfoDay[],by:'model'|'region'|'station'|'month'|'day'){
 return groupCfo(by==='model'?days.map(d=>({...d,model:modelFamily(d.model)})):days,by);
}
