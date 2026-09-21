/** One account at a time. Mirrors Workforce's associate/day/card base-pay unit. */
export type DailyCard={id:string;pay_type:string;fixed_amount:unknown;guarantee_amount:unknown;delivery_rate:unknown;return_rate:unknown;mfn_rate:unknown;mfn_return_rate:unknown;fuel_rate:unknown};
export type DailyCardSource={id:string;work_date:string;total_delivery:unknown;total_activity:unknown;c_return:unknown;mfn:unknown;mfn_return:unknown};
const number=(v:unknown)=>{if(v===null||v===undefined)return 0;const n=Number(v);if(!Number.isFinite(n)||n<0)throw new Error('Your earning source contains an invalid count or rate. Please contact Workforce.');return n;};
const money=(n:number)=>{const cents=Math.round(n*100);if(!Number.isSafeInteger(cents))throw new Error('Earnings exceed the supported calculation range.');return cents/100;};
function base(card:DailyCard,row:DailyCardSource){
 const delivery=number(row.total_delivery),activity=number(row.total_activity);
 const variable=delivery*number(card.delivery_rate)+number(row.c_return)*number(card.return_rate)+number(row.mfn)*number(card.mfn_rate)+number(row.mfn_return)*number(card.mfn_return_rate)+delivery*number(card.fuel_rate);
 if(card.pay_type==='fixed_daily')return activity>0?number(card.fixed_amount):0;
 if(card.pay_type==='fixed_monthly'){const [year,month]=row.work_date.split('-').map(Number);return activity>0?number(card.fixed_amount)/new Date(Date.UTC(year,month,0)).getUTCDate():0;}
 if(card.pay_type==='per_activity')return activity*number(card.delivery_rate)+delivery*number(card.fuel_rate);
 if(card.pay_type==='hybrid')return Math.max(variable,number(card.guarantee_amount));
 if(card.pay_type!=='per_shipment')throw new Error('This earning rate type is not supported. Please contact Workforce.');
 return variable;
}
export function allocateOwnDailyCards(input:{row:DailyCardSource;card:DailyCard}[]){
 const amounts=new Map<string,number>(),groups=new Map<string,{row:DailyCardSource;card:DailyCard}[]>();
 for(const entry of input){
  const {row,card}=entry;
  if(!row.id||amounts.has(row.id)||!card.id||!/^\d{4}-\d{2}-\d{2}$/.test(row.work_date)||!Number.isFinite(Date.parse(row.work_date))||new Date(row.work_date).toISOString().slice(0,10)!==row.work_date)throw new Error('Duplicate or invalid earning sources need Workforce reconciliation.');
  amounts.set(row.id,money(base(card,row)));
  if(['fixed_daily','fixed_monthly','hybrid'].includes(card.pay_type)){const key=row.work_date+':'+card.id;groups.set(key,[...(groups.get(key)??[]),entry]);}
 }
 for(const entries of groups.values()){
  const sorted=[...entries].sort((a,b)=>a.row.id.localeCompare(b.row.id)),combined={...sorted[0].row};
  for(const k of ['total_delivery','total_activity','c_return','mfn','mfn_return'] as const)combined[k]=sorted.reduce((sum,e)=>sum+number(e.row[k]),0);
  const cents=Math.round(money(base(sorted[0].card,combined))*100),weight=number(combined.total_activity);let distributed=0;
  sorted.forEach(({row},n)=>{const portion=n===sorted.length-1?cents-distributed:Math.floor(cents*(weight?number(row.total_activity)/weight:1/sorted.length));distributed+=portion;amounts.set(row.id,portion/100);});
 }
 return amounts;
}
