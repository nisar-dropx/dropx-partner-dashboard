export type OwnProductionDay={id:string;date:string;amount:number;baseAmount:number;incentiveAmount:number;deliveries:number;calculationSource:'workforce_rate_card'|'provider_mapping';payType:string};
const labels:Record<string,string>={fixed_daily:'Fixed daily pay',fixed_monthly:'Monthly pay · calendar-day proration',hybrid:'Daily guarantee / activity pay',per_activity:'Per-activity pay',per_shipment:'Per-shipment pay',provider_mapping:'Provider-mapped activity pay'};
const cents=(value:number)=>{const n=Math.round(value*100);if(!Number.isFinite(value)||value<0||!Number.isSafeInteger(n)||Math.abs(value*100-n)>0.00001)throw new Error('Your production breakdown could not be reconciled. Please retry.');return n;};
export function ownProductionBreakdown(days:OwnProductionDay[]){
 if(!Array.isArray(days)||days.some(day=>!day||typeof day!=='object'))throw new Error('Your production sources are unavailable. Please retry.');
 const groups=new Map<string,{label:string;amount:number;dates:Set<string>}>(),ids=new Set<string>();let base=0,incentives=0,deliveries=0;
 for(const day of days){
  if(!day.id||ids.has(day.id)||!/^\d{4}-\d{2}-\d{2}$/.test(day.date)||!Number.isFinite(Date.parse(day.date))||new Date(day.date).toISOString().slice(0,10)!==day.date||!Number.isSafeInteger(day.deliveries)||day.deliveries<0)throw new Error('Your production sources could not be reconciled. Please retry.');
  ids.add(day.id);
  const key=day.calculationSource==='provider_mapping'?'provider_mapping':day.calculationSource==='workforce_rate_card'?day.payType:'';
  if(!Object.hasOwn(labels,key)||(day.calculationSource==='workforce_rate_card'&&key==='provider_mapping'))throw new Error('Your production pay basis is unavailable. Please retry.');
  const b=cents(day.baseAmount),i=cents(day.incentiveAmount);if(b+i!==cents(day.amount))throw new Error('Daily production totals do not reconcile. Please retry.');
  base+=b;incentives+=i;deliveries+=day.deliveries;
  const group=groups.get(key)??{label:labels[key],amount:0,dates:new Set<string>()};group.amount+=b;group.dates.add(day.date);groups.set(key,group);
 }
 if(!Number.isSafeInteger(base+incentives)||!Number.isSafeInteger(deliveries))throw new Error('Your production total exceeds the supported range.');
 return {baseAmount:base/100,incentiveAmount:incentives/100,amount:(base+incentives)/100,deliveries,workDays:new Set(days.map(d=>d.date)).size,groups:[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([key,g])=>({key,label:g.label,amount:g.amount/100,days:g.dates.size}))};
}
export function reconcileOwnProduction(earnings:{daily:OwnProductionDay[]}[],summary:{baseAmount:number;incentiveAmount:number;netAmount:number;additions:number;deductionAmount:number}){
 if(!Array.isArray(earnings)||earnings.some(e=>!e||!Array.isArray(e.daily)))throw new Error('Production sources are unavailable.');
 const days=earnings.flatMap(e=>e.daily),all=ownProductionBreakdown(days);
 const netCents=Math.round(summary.netAmount*100);
 if(cents(all.baseAmount)!==cents(summary.baseAmount)||cents(all.incentiveAmount)!==cents(summary.incentiveAmount)
  ||netCents!==cents(all.amount)+cents(summary.additions)-cents(summary.deductionAmount)||!Number.isSafeInteger(netCents)||Math.abs(summary.netAmount*100-netCents)>0.00001)throw new Error('Monthly production and adjustments do not reconcile. Please retry.');
 return [...new Set(days.map(d=>d.date))].sort().reverse().map(date=>({date,...ownProductionBreakdown(days.filter(d=>d.date===date))}));
}
