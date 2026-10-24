import type {LivePnl} from '../pnl-data';
import type {Entry} from '../final-pnl/model';
export const heads = ['mg','variable','mfn','swa','xpt','fuel','ihs','smd','other'] as const;
export type Head = typeof heads[number];
export const labels: Record<Head,string> = {mg:'MG + monthly fee',variable:'Beyond-MG delivery',mfn:'MFN',swa:'SWA',xpt:'XPT fixed payout',fuel:'Fuel / support surcharge',ihs:'IHS',smd:'Same-day delivery',other:'Incentives & other income'};
export interface ReferenceRow {
 station:string;row:number;days:number;from:string;to:string;total:number;
 rates:{mg:number;mgVolume:number;fee:number;variable:number;mfn:number;swaCod:number;swaPrepaid:number;swaReject:number};
 counts:{delivered:number;returns:number;eligible:number;mfn:number;swa:number};
 heads:Record<Head,number>;
}
export interface BillingReference {month:string;source:string;sha256:string;importedAt?:string;stations:ReferenceRow[];}
export interface Invoice {key:string;station:string;reference:string;date:string;entries:Entry[];taxPaise:number;totalPaise:number;observedAt?:string;indexedAt?:string;issues:string[];}
export interface BillingSource {month:string;invoices:Invoice[];reference:BillingReference|null;}
export interface Station {code:string;base:string;active:boolean;region:string;model:string;aliases:string[];}
export const zeroHeads = ():Record<Head,number> => Object.fromEntries(heads.map(h=>[h,0])) as Record<Head,number>;
export function invoiceHead(head:string):Head {
 if(head==='Amazon MG Income')return 'mg';
 if(head==='Amazon Variable Delivery Income')return 'variable';
 if(head==='Amazon MFN Income')return 'mfn';
 if(head==='Amazon SWA Income')return 'swa';
 if(head==='Amazon XPT Income')return 'xpt';
 if(head==='Amazon Fuel Surcharge')return 'fuel';
 if(head==='Amazon Same Day Income')return 'smd';
 if(/\bIHS\b/i.test(head))return 'ihs';
 return 'other';
}
const paise=(n:string|number|null|undefined)=>Math.round(Number(n??0)*100);
export function reconcileBilling(source:BillingSource, live:LivePnl|null, stations:Station[]) {
 const mapping=new Map<string,Station>();
 for(const station of stations)for(const code of [station.code,...station.aliases]){const key=code.toUpperCase(),prior=mapping.get(key);if(prior&&prior.code!==station.code)throw Error(`Ambiguous billing station alias: ${key}`);mapping.set(key,station);}
 const byCode=new Map(stations.map(s=>[s.code,s]));
 const resolve=(code:string)=>mapping.get(code.toUpperCase());
 const base=(code:string)=>{const s=resolve(code);return s?(s.active?s.base:s.code):code;};
 const codes=new Set([...source.invoices.map(i=>base(i.station)),...(source.reference?.stations??[]).map(r=>base(r.station)),...(live?.pricing??[]).filter(p=>p.provider==='Amazon').map(p=>base(p.station))]);
 return [...codes].sort().map(code=>{
  const station=byCode.get(code);
  const invoices=source.invoices.filter(i=>base(i.station)===code);
  const reference=source.reference?.stations.find(r=>base(r.station)===code)??null;
  const sameMonth=source.reference?.month===source.month;
  const rows=(live?.revenueCalculations??[]).filter(d=>d.provider==='Amazon'&&base(d.station)===code);
  const parentRows=rows.filter(d=>d.model!=='xpt');
  const estimate=zeroHeads(),billed=zeroHeads();
  for(const d of rows){
   if(d.model==='xpt')estimate.xpt+=paise(d.base);
   else estimate.mg+=paise(d.base);
   estimate.variable+=paise(d.variable);
   estimate.mfn+=paise(d.mfnRevenue);estimate.swa+=paise(d.swaRevenue);
  }
  let debit=0;for(const invoice of invoices)for(const entry of invoice.entries){if(entry.side==='income')billed[invoiceHead(entry.head)]+=entry.paise;else debit+=entry.paise;}
  const income=invoices.length?Object.values(billed).reduce((s,n)=>s+n,0):null;
  const provisional=rows.length?Object.values(estimate).reduce((s,n)=>s+n,0):null;
  const coverage=(live?.coverage??[]).filter(c=>base(c.station)===code);
  const card=live?.pricing.find(p=>p.station===code&&p.provider==='Amazon');
  const differences:string[]=[];
  const rateFields = [['mg','mg','Monthly MG'],['mgVolume','mgVolume','MG volume'],['monthlyFee','fee','Monthly fee'],['variable','variable','Excess rate'],['mfn','mfn','MFN rate']] as const;
  if(reference&&card)for(const [key,refKey,label] of rateFields){const v=card[key];if(v==null||Math.abs(Number(v)-reference.rates[refKey])>0.0001)differences.push(`${label}: master ${v??'missing'}; ${source.reference!.month} billing ${reference.rates[refKey]}`);}
  const counts={delivered:0,returns:0,eligible:0,mfn:0,swa:0};
  for(const d of rows){counts.eligible+=Number(d.eligibleDeliveries??0);counts.returns+=Number(d.returns??0);counts.delivered+=Number(d.eligibleDeliveries??0)-Number(d.returns??0);counts.mfn+=Number(d.mfn??0);counts.swa+=Number(d.swa??0);}
  const countDifferences=sameMonth&&reference&&rows.length?Object.entries(counts).filter(([k,v])=>Math.abs(v-reference.counts[k as keyof typeof counts])>0.001).map(([k,v])=>`${k}: feed ${v}; workbook ${reference.counts[k as keyof typeof counts]}`):[];
  const issues=[...new Set([...invoices.flatMap(i=>i.issues),...rows.flatMap(d=>d.issues)])];
  if(!station)issues.push('Station mapping is missing; excluded from operating totals.');
  if(!invoices.length)issues.push('No invoice available for this billing month.');
  if(!rows.length&&station?.active)issues.push('No covered provisional revenue is available.');
  if(coverage.some(c=>c.missingDates.length))issues.push('Shipment dates are missing. The partial estimate is not comparable to a complete monthly invoice.');
  if(!sameMonth&&reference)issues.push(`Rate comparison uses ${source.reference!.month} as a reference only; confirm any subsequent contract changes.`);
  if(rows.some(d=>d.model==='xpt')&&parentRows.some(d=>Number(d.mgCumulativeEligible??0)<Number(d.mgCumulativeThreshold??0)))issues.push('XPT variable earnings use the parent rate without an MG threshold. The base station is below MG on some covered dates; confirm the combined billing settlement before treating this estimate as final.');
  if(rows.some(d=>Number(d.swa??0)>0))issues.push('SWA uses a combined estimated rate. COD / prepaid / payable rejects and incentives need invoice settlement.');
  const benchmark=sameMonth&&reference?paise(reference.total):null;
  return {code,active:station?.active===true,region:station?.region??'Unmapped',model:station?.model??'Unmapped',invoices,reference,sameMonth,estimate,billed,income,provisional,debit,tax:invoices.reduce((n,i)=>n+i.taxPaise,0),benchmark,workbookDifference:income===null||benchmark===null?null:income-benchmark,provisionalDifference:income===null||provisional===null?null:income-provisional,coverage,card:card??null,counts,rateDifferences:differences,countDifferences,issues};
 });
}
export type BillingRow=ReturnType<typeof reconcileBilling>[number];
