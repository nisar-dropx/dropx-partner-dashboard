import 'server-only';
import type {CodRemittance} from '../ops-pulse/cod-status';
import {codDay,codMoney,submittedTime,type CodSection} from './lm-cod-workflow';
import {codCacheGet} from './lm-cod-journeys';
import {reportBotDb} from './settings';
import {shortfallValue,shortfallReminder,shortfallDailyKey,hasShortfallPendency} from './lm-cod-shortfall-policy';
export async function trackCodShortfalls(company:string,location:string,rows:CodRemittance[],sourceAt:string,trackingSince:string,day:string,slot:string,pickupStart:string|null,nonPickup:boolean,leadMinutes=60){
 const db=reportBotDb();
 const existing=await db.from('cod_shortfall_ledger').select('id,remittance_id').eq('company_id',company).eq('location_id',location).in('remittance_id',rows.map(r=>r.id));
 if(existing.error)throw new Error(existing.error.message);
 const known=new Map((existing.data||[]).map(x=>[x.remittance_id,x.id]));
 const inserts=[];
 for(const row of rows){const at=submittedTime(row);if(!at)continue;const short=shortfallValue(row.expectedAmount,row.actualAmount);if(short===null)continue;
  if(known.has(row.id)){const saved=await db.from('cod_shortfall_ledger').update({last_source_short:short,last_source_at:sourceAt}).eq('id',known.get(row.id)).lt('last_source_at',sourceAt);if(saved.error)throw new Error(saved.error.message);}
  else if(short>10&&codDay(at)>=trackingSince)inserts.push({company_id:company,location_id:location,remittance_id:row.id,remittance_code:row.code||row.id,deposit_date:codDay(at),expected_amount:row.expectedAmount,deposited_amount:row.actualAmount,original_short:short,last_source_short:short,last_source_at:sourceAt});
 }
 if(inserts.length){const saved=await db.from('cod_shortfall_ledger').upsert(inserts,{onConflict:'company_id,location_id,remittance_id',ignoreDuplicates:true});if(saved.error)throw new Error(saved.error.message);}
 const ledger=await db.from('cod_shortfall_ledger').select('id,remittance_code,deposit_date,expected_amount,deposited_amount,original_short,recovered_amount,last_source_short,remaining_amount').eq('company_id',company).eq('location_id',location).gt('remaining_amount',10).order('deposit_date').limit(501);
 if(ledger.error)throw new Error(ledger.error.message);
 if((ledger.data||[]).length>500)throw new Error('Shortfall ledger exceeds compact report limit; no incomplete reminder sent');
 const open=(ledger.data||[]).filter(r=>Number(r.remaining_amount)>10);
 const key=shortfallDailyKey(day);
 const alreadySent=await codCacheGet(company,location,day,key);
 const selected=alreadySent?[]:open.filter(row=>shortfallReminder(row.deposit_date,day,slot,pickupStart,nonPickup,leadMinutes));
 const acks=selected.length?[key]:[];
 const section:CodSection|null=selected.length?{key:'short',title:'Short deposit pendency · date-wise ledger',columns:['Deposit date','Reference','Expected','Deposited','Short','Recovered','Balance'],rows:selected.map(r=>[r.deposit_date,r.remittance_code,codMoney(Number(r.expected_amount)),codMoney(Number(r.deposited_amount)),codMoney(Number(r.original_short)),codMoney(Number(r.recovered_amount)),codMoney(Number(r.remaining_amount))]),owner:'tl',tone:'attention',action:`Short deposit balance: ${codMoney(selected.reduce((n,r)=>n+Number(r.remaining_amount),0))}. ${selected.some(r=>r.deposit_date<day)?'The previous deposit shortage is still open. Include this balance in today’s CMS handover and upload the recovery slip in OpsPulse.':'Include this balance in the next day’s CMS handover and upload the recovery slip in OpsPulse.'}`} : null;
 return {section,acks};
}
