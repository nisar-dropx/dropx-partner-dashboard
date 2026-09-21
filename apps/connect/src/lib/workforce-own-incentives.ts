/** Self-service projection of Workforce's associate/day/campaign calculation. No writes. */
export type OwnCampaign={id:string;company_id:string;name:string;provider_id:string|null;station_id:string|null;designation_id:string|null;metric:string;calculation_type:string;threshold_value:unknown;rate_value:unknown;flat_amount:unknown;maximum_amount:unknown;effective_from:string;effective_to:string;status:string;approved_at:string|null};
export type IncentiveSource={id:string;work_date:string;provider_id:string;station_id:string|null;total_delivery:unknown;total_activity:unknown;amazon_delivery:unknown;swa_delivery:unknown;c_return:unknown;mfn:unknown};
export type OwnIncentiveSummary={amount:number;campaigns:Array<{id:string;name:string;amount:number;workDays:number}>};
const metrics=['total_delivery','total_activity','amazon_delivery','swa_delivery','c_return','mfn'] as const;
const validDate=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
function number(value:unknown){const n=value==null?0:Number(value);if(!Number.isFinite(n)||n<0)throw new Error('An incentive source or rate needs Workforce review.');return n;}
function cents(value:number){const n=Math.round((value+Number.EPSILON)*100);if(!Number.isSafeInteger(n))throw new Error('Incentive amounts exceed the supported range.');return n;}

/** Input sources must already resolve to the authenticated person's effective mapping. */
export function ownIncentives(input:{companyId:string;canonical:boolean;designationId:string|null;from:string;to:string;sources:IncentiveSource[];campaigns:OwnCampaign[]}){
 if(!validDate(input.from)||!validDate(input.to)||input.from>input.to)throw new Error('Invalid incentive period.');
 const bySource=new Map<string,number>(),summary:OwnIncentiveSummary={amount:0,campaigns:[]};
 for(const row of input.sources){
  if(!row.id||bySource.has(row.id)||!validDate(row.work_date)||row.work_date<input.from||row.work_date>input.to||!row.provider_id)throw new Error('Duplicate or invalid incentive source needs Workforce review.');
  for(const metric of metrics)if(!Number.isSafeInteger(number(row[metric])))throw new Error('Incentive activity counts need Workforce review.');
  bySource.set(row.id,0);
 }
 const seen=new Set<string>();let total=0;
 for(const campaign of input.campaigns){
  if(campaign.company_id!==input.companyId||!campaign.id||seen.has(campaign.id))throw new Error('Incentive company scope or identity could not be verified.');
  seen.add(campaign.id);
  const eligible=campaign.status==='active'||(['paused','closed'].includes(campaign.status)&&Boolean(campaign.approved_at)&&Boolean(campaign.effective_to));
  if(!input.canonical||!eligible||(campaign.designation_id&&campaign.designation_id!==input.designationId))continue;
  if(!validDate(campaign.effective_from)||!validDate(campaign.effective_to)||campaign.effective_from>campaign.effective_to||!metrics.includes(campaign.metric as typeof metrics[number])||!['flat_threshold','per_unit_above_threshold'].includes(campaign.calculation_type))throw new Error('An incentive policy needs Workforce review.');
  const threshold=number(campaign.threshold_value),rate=number(campaign.rate_value),flat=number(campaign.flat_amount),maximum=campaign.maximum_amount==null?null:number(campaign.maximum_amount);
  const days=new Map<string,IncentiveSource[]>();
  for(const row of input.sources){
   if(row.work_date<campaign.effective_from||row.work_date>campaign.effective_to||(campaign.provider_id&&campaign.provider_id!==row.provider_id)||(campaign.station_id&&campaign.station_id!==row.station_id))continue;
   days.set(row.work_date,[...(days.get(row.work_date)??[]),row]);
  }
  let campaignTotal=0,workDays=0;
  for(const group of days.values()){
   const rows=[...group].sort((a,b)=>a.id.localeCompare(b.id));
   const metric=rows.reduce((sum,row)=>sum+number(row[campaign.metric as typeof metrics[number]]),0);
   const value=campaign.calculation_type==='flat_threshold'?(metric>=threshold?flat:0):Math.max(metric-threshold,0)*rate;
   const daily=cents(maximum===null?value:Math.min(value,maximum));
   if(!daily)continue;
   const weight=rows.reduce((sum,row)=>sum+number(row.total_activity),0);let distributed=0;
   rows.forEach((row,index)=>{const portion=index===rows.length-1?daily-distributed:Math.floor(daily*(weight?number(row.total_activity)/weight:1/rows.length));distributed+=portion;const sum=cents(bySource.get(row.id)!)+portion;if(!Number.isSafeInteger(sum))throw new Error('Incentive total exceeds the supported range.');bySource.set(row.id,sum/100);});
   campaignTotal+=daily;workDays++;
  }
  if(!Number.isSafeInteger(campaignTotal))throw new Error('Incentive total exceeds the supported range.');
  if(campaignTotal)summary.campaigns.push({id:campaign.id,name:campaign.name,amount:campaignTotal/100,workDays});
  total+=campaignTotal;
 }
 if(!Number.isSafeInteger(total))throw new Error('Incentive total exceeds the supported range.');
 summary.amount=total/100;return{bySource,summary};
}
