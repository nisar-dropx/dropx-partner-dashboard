import {lossCategory} from './nl-recovery.ts';
import {isRecoverable} from '../../ops-pulse/nl-loss-policy.ts';
import {hasFinalLossOutcome} from '../../ops-pulse/loss-recovery-controls.ts';
import {monthValue,monthEnd,paise,type Entry} from './model.ts';
type Row=Record<string,any>;
export type LossPeriodRule={report:'nl'|'slp';period:string;pnl_month:string;source:string};
export function validateLossPeriod(value:Row):LossPeriodRule {
 if(!['nl','slp'].includes(value.report))throw Error('Choose NL or SLP.');
 const period=String(value.period??'').trim(),source=String(value.source??'').trim();
 if(!period||period.length>80||!source||source.length>500)throw Error('Enter the loss period and billing confirmation source.');
 return {report:value.report,period,pnl_month:monthValue(value.pnl_month),source};
}
export function lossRecognitionMonth(row:Row,rules:LossPeriodRule[]=[]){
 const period=row.report==='slp'?(row.details?.period||row.month):row.month;
 const matches=rules.filter(r=>r.report===row.report&&r.period===period);
 if(matches.length>1)throw Error(`Conflicting P&L months for ${row.report} ${period}. Review Loss billing periods in Master.`);
 if(matches.length){const target=monthValue(matches[0].pnl_month);if(target<row.month)throw Error(`Loss billing month cannot precede incident month ${row.month}.`);return target;}
 const [year,month]=monthValue(row.month).split('-').map(Number);
 return `${month===12?year+1:year}-${String(month===12?1:month+1).padStart(2,'0')}`;
}
/** Same finalized/recoverable gate as Team Ops. Initial and won-dispute cases
 * cannot become station charges merely because a recovery plan was entered. */
export function finalRecoverableLoss(row:Row,accepted:string[]){
 if(row.source_present!==true||row.redispute?.workflow_status==='won'||row.lifecycle_status==='not_recoverable')return false;
 if(row.report==='slp')return row.details?.in_final===true||row.details?.in_final==='true';
 return row.report==='nl'&&isRecoverable(row.source_status,accepted)&&hasFinalLossOutcome(true,row.source_status,row.details?.case_status,row.details?.extra?.current_sla_stage);
}
export function stationLossEntries(month:string,cases:Row[],accepted:string[],rules:LossPeriodRule[]=[]){
 const entries:Entry[]=[],seen=new Set<string>();
 for(const row of cases){
  if(!finalRecoverableLoss(row,accepted)||lossRecognitionMonth(row,rules)!==month)continue;
  const id=`loss:ops:${row.month}:${row.case_key}`;
  if(seen.has(id))throw Error(`Duplicate Ops loss case ${row.case_key}.`);seen.add(id);
  const amount=paise(row.amount);if(amount<0)throw Error(`Invalid loss amount for ${row.case_key}.`);if(!amount)continue;
  const report=String(row.report).toUpperCase(),period=row.details?.period||row.month;
  entries.push({id,month,station:row.station_code,sourceStation:row.station_code,side:'expense',head:`${report} loss`,description:`${report} final recoverable ${lossCategory(row.report,row.details)} · ${period} · ${row.case_key}`,paise:amount,source:'Ops Pulse final losses',reference:row.case_key,date:monthEnd(month),caseKey:`nl:${row.month}:${row.case_key}`});
 }
 return entries;
}
