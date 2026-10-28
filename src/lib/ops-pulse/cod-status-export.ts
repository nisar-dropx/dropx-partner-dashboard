import { codStatusChecks, codStatusToday, classifyRemittance, type CodPart, type CodStatusLocation, type CodStatusSnapshot } from './cod-status.ts';
import { reconciliationView, reconciliationAgeing, collectionDay } from './cod-reconciliation.ts';
import { codRemittanceRows, defaultRemittanceTolerance, remittanceAmountCheck } from './cod-remittance-variance.ts';

export type CodExportEntry = { location: CodStatusLocation; snapshot?: CodStatusSnapshot; error?: string; loading?: boolean };
export type CodExportOptions = { part?: CodPart; collectionDate: string; agedOnly?: boolean; now: Date };
type Cell = string | number | null;
export type CodExportSheet = { name: string; rows: Cell[][]; moneyColumns?: number[] };
const numeric = (n: number | null | undefined): Cell => typeof n === 'number' && Number.isFinite(n) ? n : 'Not available';
const time = (v: string | number | null | undefined) => v && Number.isFinite(new Date(v).getTime()) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(v)) : 'Not available';
const round = (n: number) => Math.round(n * 100) / 100;

/** Export only the caller's already-authorized, visible snapshots. No extra fetch or hidden locations. */
export function codStatusExportSheets(entries: CodExportEntry[], options: CodExportOptions): CodExportSheet[] {
 const { now, collectionDate, agedOnly, part } = options;
 const today = codStatusToday(now);
 const overview: CodExportSheet = { name: 'Station overview', moneyColumns: [8,10,12], rows: [['Station','Station name','Model','Region','Cluster / AOM','Last checked IST','Refresh state','DA status','DA pending amount','Prepare status','Expected cash to prepare','Remittance status','Open remittance amount']] };
 const associates: CodExportSheet = { name: 'Associates', moneyColumns: [4,6,7], rows: [['Station','Associate ID','Associate name','Selection','Pending amount','Shipment count','Shipment breakdown amount','Unallocated balance','Source','Checked IST','Source completeness']] };
 const shipments: CodExportSheet = { name: 'Shipments', moneyColumns: [10], rows: [['Station','Associate ID','Associate name','Shipment ID','Payment method','COD / pending since IST','Date basis','Last source update IST','Age days','Age / status','Pending amount','Source','Checked IST']] };
 const prepare: CodExportSheet = { name: 'Prepare deposit', moneyColumns: [1,2,3,4], rows: [['Station','Expected cash','Actual cash','Short / excess','Digital liability (separate)','Assessment','Checked IST','Source state']] };
 const remittances: CodExportSheet = { name: 'Remittances', moneyColumns: [4,5,6], rows: [['Station','Remittance','Portal status','Assessment','Expected','Actual','Short / excess','Created IST','Last updated IST','Submitted by','Window start IST','Window end IST','Checked IST','Source completeness']] };
 const info: CodExportSheet = { name: 'Report info', rows: [['Field','Value'],['Exported IST',time(now.toISOString())],['Section',part || 'All sections'],['Collection date',agedOnly?'Age threshold per station (all dates)':collectionDate || 'All outstanding dates'],['Stations',entries.map(e=>e.location.code).join(', ')],['Amounts','INR. DA cash, Prepare Deposit and remittances are separate balances; do not add them together.'],['Dates','Current outstanding snapshot, not a historical closing balance. Collection date applies only to DA cash.'],['Source','Pending transaction dates and SCC source update times are labelled separately. Missing dates remain unverified.'],['Settlement','Submitted is the portal status, not confirmation of bank settlement.']] };
 for (const { location: l, snapshot: s, error, loading } of entries) {
  const check=codStatusChecks(s,l.pickup||null,now,!!error,collectionDate,l.reconDueTime||null,l.maxAgeMinutes??null,l.remittanceTolerance);
  const data=s?.reconciliation.data;
  const view=reconciliationView(data,collectionDate,l.reconDueTime||null,now);
  const drivers=agedOnly?reconciliationAgeing(data,l.ageFlagDays??null,now).drivers:view.drivers;
  const selection=agedOnly?`${l.ageFlagDays}+ day pending`:collectionDate || 'All outstanding dates';
  overview.rows.push([l.code,l.name,l.model,l.region,l.manager,time(s?.fetchedAt),loading?'Refreshing · last snapshot':error || (!s?'Not checked':'Loaded'),check.reconciliation.label,data?numeric(view.amount):'Not available',check.prepareDeposit.label,numeric(s?.prepareDeposit.data?.expectedAmount),check.remittances.label,numeric(s?.remittances.data?.openAmount)]);
  if (!s) info.rows.push([l.code,'Not checked; no detail data available.']);
  if (error) info.rows.push([`${l.code} refresh error`,error]);
  if (loading) info.rows.push([`${l.code} refreshing`,'Export uses the last displayed snapshot.']);
  if (agedOnly) info.rows.push([`${l.code} age threshold`,l.ageFlagDays??'Not configured']);
  for (const d of drivers) {
   const total=round(d.packages.reduce((n,p)=>n+p.amount,0));
   associates.rows.push([l.code,String(d.id),d.name,selection,numeric(d.pendingAmount),d.packages.length,numeric(total),numeric(round(d.pendingAmount-total)),d.source==='scc_cash_with_associate'?'SCC cash pendency':'Amazon reconciliation',time(s?.reconciliation.checkedAt),data?.complete?'Complete':'Incomplete']);
   for (const p of d.packages) {
    const day=collectionDay(p.collectedAt,now),age=day?Math.round((Date.parse(today)-Date.parse(day))/86400000):null;
    const overdue=age!==null&&(age>0||!!l.reconDueTime&&now.getTime()>=Date.parse(`${today}T${l.reconDueTime}:00+05:30`));
    shipments.rows.push([l.code,String(d.id),d.name,String(p.trackingId),p.paymentMethod,day?time(p.collectedAt):'Date unverified',p.dateSource==='pending_transaction'?'Pending transaction · Amazon date':day?'Collection date':'Date unverified',time(p.sourceUpdatedAt??p.transactionAt),age,age===null?'Date unverified':age>0?`${age} days · overdue`:overdue?'Today · overdue':'Today',numeric(p.amount),p.source==='scc_cash_with_associate'?'SCC cash state update':'COD transaction',time(s?.reconciliation.checkedAt)]);
   }
  }
  const p=s?.prepareDeposit.data;
  prepare.rows.push([l.code,numeric(p?.expectedAmount),numeric(p?.actualAmount),numeric(p?.variance),numeric(p?.digitalAmount),check.prepareDeposit.label,time(s?.prepareDeposit.checkedAt),s?.prepareDeposit.state||'Not checked']);
  const m=s?.remittances.data;
  if (m) for (const r of codRemittanceRows(m)) {
   const cash=remittanceAmountCheck(r,l.remittanceTolerance??defaultRemittanceTolerance);
   const assessment=cash||(['CREATED','PENDING_SUBMISSION'].includes(r.status.toUpperCase())?classifyRemittance(r,m.latestSubmitted,l.pickup||null,now):null);
   remittances.rows.push([l.code,r.code||'Code not issued',r.status,assessment?.label||'—',numeric(r.expectedAmount),numeric(r.actualAmount),numeric(cash?cash.difference:r.variance),time(r.createdAt),time(r.updatedAt),r.submittedBy||'—',time(s?.remittanceWindow.startTime),time(s?.remittanceWindow.endTime),time(s?.remittances.checkedAt),m.complete?'Complete':'Incomplete']);
  }
  if (!data || !data.complete) info.rows.push([`${l.code} reconciliation`,'Unavailable or incomplete; missing records do not mean zero balance.']);
  if (!m || !m.complete) info.rows.push([`${l.code} remittances`,'Unavailable or incomplete; absence of rows does not confirm clearance.']);
 }
 return [...(!part?[overview]:[]),...(!part||part==='reconciliation'?[associates,shipments]:[]),...(!part||part==='prepareDeposit'?[prepare]:[]),...(!part||part==='remittances'?[remittances]:[]),info];
}
