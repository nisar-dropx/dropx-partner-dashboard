import type {SupabaseClient} from '@supabase/supabase-js';

type Account={id:string;companyId:string;profileType:string;workspace:string;pageAccess:string[]};
type AdjustmentRow={id:string;company_id:string;workforce_id:string;adjustment_type:string;category:string;amount:number|string;effective_date:string;status:string;requested_at:string;reviewed_at:string|null;payroll_run_id:string|null};
type MileageRow={adjustment_id:string;company_id:string;workforce_id:string;work_date:string;kilometres:number|string;rate_per_km:number|string};
export type OwnAdjustment={id:string;kind:'earning'|'deduction';category:string;amount:number;postingDate:string;status:string;requestedAt:string;reviewedAt:string|null;includedInEstimate:boolean;mileage:null|{workDate:string;kilometres:number;ratePerKm:number}};
export type OwnAdjustmentLedger={available:boolean;entries:OwnAdjustment[];summary:{additions:number;deductions:number;net:number;pendingCount:number}};
const statuses=['pending','approved','rejected','posted','cancelled'];
const empty=(available:boolean):OwnAdjustmentLedger=>({available,entries:[],summary:{additions:0,deductions:0,net:0,pendingCount:0}});
const validDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
function cents(value:number|string){const n=Number(value);if(!Number.isFinite(n)||n<=0||!Number.isSafeInteger(Math.round(n*100))||Math.abs(n*100-Math.round(n*100))>0.0001)throw new Error('An adjustment amount needs Workforce review.');return Math.round(n*100);}
function assertPeriod(from:string,to:string){if(!validDate(from)||!validDate(to)||from>to||Date.parse(to)-Date.parse(from)>92*86400000)throw new Error('Choose a valid adjustment period of at most 93 days.');}

/** Only these whitelisted fields may reach an associate. Never spread a database row. */
export function ownAdjustmentLedger(rows:AdjustmentRow[],mileage:MileageRow[],company:string,person:string,from:string,to:string):OwnAdjustmentLedger{
 assertPeriod(from,to);const result=empty(true),seen=new Map<string,string>(),mileageById=new Map<string,MileageRow>();
 for(const row of mileage){
  if(row.company_id!==company||row.workforce_id!==person)throw new Error('Mileage account scope could not be verified.');
  if(mileageById.has(row.adjustment_id))throw new Error('Duplicate mileage evidence needs Workforce review.');
  mileageById.set(row.adjustment_id,row);
 }
 let added=0,deducted=0;
 for(const row of rows){
  if(row.company_id!==company||row.workforce_id!==person)throw new Error('Adjustment account scope could not be verified.');
  if(!validDate(row.effective_date)||row.effective_date<from||row.effective_date>to)throw new Error('Adjustment dates could not be reconciled.');
  if(!statuses.includes(row.status)||!['earning','deduction'].includes(row.adjustment_type))throw new Error('Adjustment status needs Workforce review.');
  if(!row.id||!Number.isFinite(Date.parse(row.requested_at))||(row.reviewed_at!==null&&!Number.isFinite(Date.parse(row.reviewed_at))))throw new Error('Adjustment history needs Workforce review.');
  const amount=cents(row.amount),included=['approved','posted'].includes(row.status),claim=mileageById.get(row.id);
  if(row.status==='posted'&&!row.payroll_run_id)throw new Error('Payroll attribution needs Workforce review.');
  if((included||row.status==='rejected')&&!row.reviewed_at)throw new Error('Adjustment review evidence is missing.');
  let claimSummary:OwnAdjustment['mileage']=null;
  if(claim){
   const km=Number(claim.kilometres),rate=Number(claim.rate_per_km);
   if(!validDate(claim.work_date)||claim.work_date>row.effective_date||!Number.isFinite(km)||km<=0||!Number.isFinite(rate)||rate<=0||Math.abs(Math.round(km*rate*100)-amount)>0)throw new Error('Mileage amount could not be reconciled.');
   claimSummary={workDate:claim.work_date,kilometres:km,ratePerKm:rate};
  }
  const entry:OwnAdjustment={id:row.id,kind:row.adjustment_type as OwnAdjustment['kind'],category:claim?'mileage':row.category,amount:amount/100,postingDate:row.effective_date,status:row.status,requestedAt:row.requested_at,reviewedAt:row.reviewed_at,includedInEstimate:included,mileage:claimSummary};
  const fingerprint=JSON.stringify(entry);
  if(seen.has(row.id)){if(seen.get(row.id)!==fingerprint)throw new Error('Adjustment records changed during loading. Refresh to reconcile.');continue;}
  seen.set(row.id,fingerprint);result.entries.push(entry);
  if(included){if(row.adjustment_type==='earning')added+=amount;else deducted+=amount;}
  if(row.status==='pending')result.summary.pendingCount++;
 }
 if(!Number.isSafeInteger(added)||!Number.isSafeInteger(deducted))throw new Error('Adjustment totals exceed the supported range.');
 result.entries.sort((a,b)=>b.postingDate.localeCompare(a.postingDate)||b.requestedAt.localeCompare(a.requestedAt)||a.id.localeCompare(b.id));
 result.summary={...result.summary,additions:added/100,deductions:deducted/100,net:(added-deducted)/100};return result;
}

/** Called only after requireConnectAccount has authenticated the requested self-service account. */
export async function loadOwnAdjustmentLedger(db:SupabaseClient,account:Account,from:string,to:string):Promise<OwnAdjustmentLedger>{
 if(account.workspace!=='workforce'||!account.pageAccess.includes('earnings'))throw new Error('Earnings access is required.');
 assertPeriod(from,to);
 let identity=db.from('workforce').select('id').eq('company_id',account.companyId).is('deleted_at',null).neq('migration_state','reclassified');
 if(account.profileType==='workforce')identity=identity.eq('id',account.id);
 else if(['contractor','field_executive','employee'].includes(account.profileType))identity=identity.eq('source_profile_type',account.profileType).eq('source_profile_id',account.id);
 else return empty(false);
 const canonical=await identity.maybeSingle();
 if(canonical.error)throw new Error('Your canonical Workforce payment identity could not be verified.');
 if(!canonical.data)return empty(false);
 const person=canonical.data.id,rows:AdjustmentRow[]=[];
 for(let offset=0;offset<10000;offset+=500){
  const result=await db.from('workforce_adjustments').select('id,company_id,workforce_id,adjustment_type,category,amount,effective_date,status,requested_at,reviewed_at,payroll_run_id')
   .eq('company_id',account.companyId).eq('workforce_id',person).in('status',statuses).gte('effective_date',from).lte('effective_date',to).order('id').range(offset,offset+499);
  if(result.error)throw new Error('Your adjustments could not be loaded. Refresh before relying on the payment estimate.');
  rows.push(...(result.data??[]) as AdjustmentRow[]);
  if((result.data??[]).length<500)break;
  if(offset===9500)throw new Error('Too many adjustments to reconcile safely. Contact Workforce.');
 }
 const mileage:MileageRow[]=[];
 for(let n=0;n<rows.length;n+=100){
  const result=await db.from('workforce_mileage_claims').select('adjustment_id,company_id,workforce_id,work_date,kilometres,rate_per_km')
   .eq('company_id',account.companyId).eq('workforce_id',person).in('adjustment_id',rows.slice(n,n+100).map(row=>row.id));
  if(result.error)throw new Error('Your mileage summary could not be verified. Please retry.');
  mileage.push(...(result.data??[]) as MileageRow[]);
 }
 return ownAdjustmentLedger(rows,mileage,account.companyId,person,from,to);
}
