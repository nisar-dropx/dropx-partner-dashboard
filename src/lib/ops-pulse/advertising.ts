import type { CpsSnapshot, CpsLine } from "./cps";
export type AdvertisingDay = { account_id:string; spend_date:string; ad_id:string; ad_name:string; campaign_name:string; spend:number; currency:string; synced_at:string };
export type AdvertisingMapping = { id?:string; ad_id:string; station_code:string; effective_from:string; effective_to:string|null };
export type AdvertisingAd = { meta_ad_id:string|null; station_code:string|null };
export type AdvertisingMonth = { month:string; through_date:string|null; synced_at:string|null; last_error:string|null };
export type AdvertisingDetail = AdvertisingDay & { station_code:string };
export const advertisingSource = "Meta Ads Insights";
export function mapAdvertising(rows:AdvertisingDay[], mappings:AdvertisingMapping[], ads:AdvertisingAd[]) {
 const known = new Map<string,Set<string>>();
 for(const ad of ads) if(ad.meta_ad_id&&ad.station_code){const codes=known.get(ad.meta_ad_id)??new Set<string>();codes.add(ad.station_code.trim().toUpperCase());known.set(ad.meta_ad_id,codes);}
 return rows.map(row=>{
  const explicit=mappings.filter(m=>m.ad_id===row.ad_id&&m.effective_from<=row.spend_date&&(!m.effective_to||m.effective_to>=row.spend_date));
  const codes=explicit.length ? new Set(explicit.map(m=>m.station_code)) : known.get(row.ad_id);
  return {...row,spend:Number(row.spend),station_code:codes?.size===1?[...codes][0]:""};
 });
}
export function advertisingCosts(input:{rows:AdvertisingDetail[];months:AdvertisingMonth[];codes:string[];from:string;to:string;start:string;label:string;enabled:boolean;refreshMinutes:number;now?:number}) {
 const rows=input.rows.filter(r=>input.codes.includes(r.station_code)&&r.spend_date>=input.from&&r.spend_date<=input.to);
 const breakup:CpsLine[]=rows.filter(r=>r.spend>0).map(r=>({station_code:r.station_code,work_date:r.spend_date,head:"Other",sub_head:input.label,source:advertisingSource,amount:r.spend}));
 const gaps:NonNullable<CpsSnapshot["gaps"]>=[];
 for(const station of input.codes) {
  const issues=new Map<string,{from:string;to:string;days:number}>();
  for(let d=input.from;d<=input.to;d=new Date(Date.parse(d)+86400000).toISOString().slice(0,10)) {
   if(d<input.start)continue;
   const month=input.months.find(m=>m.month===d.slice(0,7)+"-01");
   const stale=month?.synced_at && (input.now??Date.now())-Date.parse(month.synced_at)>Math.max(input.refreshMinutes*3,1440)*60000 && d.slice(0,7)===new Date(input.now??Date.now()).toISOString().slice(0,7);
   const kind=!month?.through_date||d>month.through_date?"Meta advertising sync pending":month.last_error||stale?"Meta advertising refresh needs attention":null;
   if(kind){const issue=issues.get(kind)??{from:d,to:d,days:0};issue.to=d;issue.days++;issues.set(kind,issue);}
  }
  const unassigned=input.rows.filter(r=>!r.station_code&&r.spend>0&&r.spend_date>=input.from&&r.spend_date<=input.to).map(r=>r.spend_date).sort();
  if(unassigned.length)issues.set("Meta ad station mapping pending",{from:unassigned[0],to:unassigned.at(-1)!,days:new Set(unassigned).size});
  for(const [kind,issue] of issues)gaps.push({key:`advertising|${station}|${kind}`,kind,station_code:station,provider_id:"",dropx_id:"",name:"",first_date:issue.from,last_date:issue.to,days:issue.days,deliveries:0,known_cost:0,owner:"Advertising master",href:"https://ops.dropxlogistics.com/master/advertising"});
 }
 return {breakup,gaps,rows};
}

export type AdvertisingSettlementRule={source:string;cost_label:string;effective_from:string;is_active:boolean};
export function excludeAdvertisingSettlements(base:CpsSnapshot,rules:AdvertisingSettlementRule[]) {
 const same=(a:string,b:string)=>a.trim().toLowerCase()===b.trim().toLowerCase();
 const excluded=(source:string,label:string,date:string)=>rules.some(r=>r.is_active&&same(r.source,source)&&same(r.cost_label,label)&&r.effective_from<=date);
 return {...base,breakup:base.breakup.filter(l=>!excluded(l.source,l.sub_head,l.work_date)),expense_periods:base.expense_periods?.filter(b=>!excluded(b.source==='cashbook'?'Cashbook':'Approved payment requests',b.label,b.booked_on))};
}
