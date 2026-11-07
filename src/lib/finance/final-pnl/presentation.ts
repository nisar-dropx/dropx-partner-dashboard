import type {Entry} from './model';
import {stationLossCategory,type StationPnlSummary} from './station-summary.ts';

/** Display-only reclassification. Source IDs, correction history and saved
 * accounting sides remain unchanged; editors must receive the original row. */
export function pnlDisplayEntry(entry:Entry):Entry {
 const recovery=entry.recovery&&entry.side==='income';
 const loss=!entry.recovery&&stationLossCategory(entry)!==null;
 if(!recovery&&!loss)return entry;
 return {...entry,side:recovery?'expense':'income',head:recovery?'Loss recovery':'Loss incurred',paise:-entry.paise,
  details:entry.details?.map(detail=>({...detail,paise:-detail.paise}))};
}
export const pnlDisplayEntries=(entries:Entry[])=>entries.map(pnlDisplayEntry);
export const allocatedCorporate=(row:StationPnlSummary)=>row.corporateEntries.reduce((n,e)=>n+e.paise,0);
export const currentRevenue=(row:StationPnlSummary)=>row.revenue-row.chargebacks;
export const currentDirectExpenses=(row:StationPnlSummary)=>row.operatingExpense-row.recovery;
export function stationAlerts(row:StationPnlSummary):string[] {
 const issues=row.issues.map(issue=>issue.replace('this station',row.station));
 if(row.entries.some(e=>/accrual|review/i.test(e.source)))issues.push('Includes salary, rent or payroll accruals awaiting final payroll or bills. These recorded amounts are included in the current P&L.');
 if(row.entries.some(e=>e.sourceChanged))issues.push('Some source records changed after a saved correction. Review those entries against their latest evidence.');
 return [...new Set(issues)];
}
