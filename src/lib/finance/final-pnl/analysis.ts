import type {Dimension,Entry,Report} from './model';
export type PnlFilters={region:string[];state:string[];model:string[];format:string[];manager:string[];station:string[]};
export const emptyFilters=():PnlFilters=>({region:[],state:[],model:[],format:[],manager:[],station:[]});
const facetValues=(d:Dimension,key:keyof PnlFilters)=>key==='manager'?d.managers:[key==='station'?d.code:key==='format'?(d.format||'Not applicable'):d[key]];
export function facetOptions(dimensions:Dimension[],filters:PnlFilters,key:keyof PnlFilters){return [...new Set(dimensions.filter(d=>matchesDimension(d,{...filters,[key]:[]})).flatMap(d=>facetValues(d,key)))].sort();}
/** The changed filter wins. Keep other selections only while they can coexist. */
export function updateFilters(dimensions:Dimension[],filters:PnlFilters,key:keyof PnlFilters,values:string[]){
 const next=emptyFilters();next[key]=values;
 for(const other of ['model','format','region','state','manager','station'] as const){if(other===key)continue;const allowed=facetOptions(dimensions,next,other);next[other]=filters[other].filter(v=>allowed.includes(v));}
 return next;
}
export function modelLabel(code:string){return ({NOW:'Amazon Now',AMXL:'Amazon XL',MDH:'Flipkart MDH',ODH:'Flipkart ODH',FM:'Meesho FM',HO:'HO'} as Record<string,string>)[code]??code;}
/** Presentation groups only: keep original heads, source IDs and amounts intact. */
export function statementHead(e:Pick<Entry,'side'|'head'>){
 const head=e.head.trim().replace(/\s+/g,' ');
 if(e.side!=='expense')return head;
 if(/^(?:vehicle rent|van rental expenses)(?:\s*[·:–—-]|$)/i.test(head))return 'Vehicle rent';
 if(/^vehicle run(?:\s*[·:–—-]|$)/i.test(head))return 'Vehicle run';
 if(/^(?:ad[ -]?hoc van|van ad[ -]?hoc)(?:\s*[·:–—-]|$)/i.test(head))return 'Adhoc Van';
 const aliases:Record<string,string>={
  'van fuel':'Vehicle fuel','van fuel expenses':'Vehicle fuel','iocl fuel':'Vehicle fuel','bpcl fuel':'Vehicle fuel',
  'vehicle service/maintanace':'Vehicle maintenance','vehicle maintanance expenses':'Vehicle maintenance',
  'vehicle maintenance expenses':'Vehicle maintenance','vehicle repair / tyre':'Vehicle maintenance',
  'broadband charge':'Broadband','broadband expenses':'Broadband',
  'office and stationary':'Stationery','office and stationery':'Stationery',
  'office rent':'Facility rent and maintenance',
 };
 return aliases[head.toLowerCase()]??head;
}
const headOrder=['Workforce payouts','Helper payouts','UTR salaries','Manager share','HO salaries','Vehicle run','Vehicle rent','Vehicle fuel','Vehicle maintenance','Adhoc Van','Adhoc Driver','Adhoc DA / WM','Facility rent and maintenance','Electricity Bill','Broadband','Drinking Water','Water Bill','Cleaning Expenses','Stationery','Loss chargeback','Regional HO allocation'];
export function statementGroups(entries:Entry[]){
 const groups=new Map<string,{key:string;head:string;side:Entry['side'];entries:Entry[];paise:number}>();
 for(const entry of entries){if(entry.deleted)continue;const head=statementHead(entry),key=entry.side+':'+head.toLowerCase();const group=groups.get(key)??{key,head,side:entry.side,entries:[],paise:0};group.entries.push(entry);group.paise+=entry.paise;groups.set(key,group);}
 const rank=(head:string)=>{const i=headOrder.indexOf(head);return i<0?headOrder.length:i;};
 return [...groups.values()].sort((a,b)=>a.side.localeCompare(b.side)||(a.side==='expense'?rank(a.head)-rank(b.head):0)||a.head.localeCompare(b.head));
}
export function hoLabel(code:string,mode:'regional'|'corporate'){return mode==='corporate'?`${code} Corporate`:code;}
export type GroupBy='region'|'state'|'model'|'manager'|'station';
export function dimensionFor(code:string,dimensions:Dimension[]):Dimension{return dimensions.find(d=>d.code===code)??{code,name:code,region:'Unassigned',state:'Unassigned',model:'Unassigned',cluster:'Unassigned',managers:['Unassigned'],isHo:/^HO(?:_|$)/i.test(code)};}
export function matchesDimension(d:Dimension,f:PnlFilters){return (!f.region.length||f.region.includes(d.region))&&(!f.state.length||f.state.includes(d.state))&&(!f.model.length||f.model.includes(d.model))&&(!f.format.length||f.format.includes(d.format||'Not applicable'))&&(!f.manager.length||d.managers.some(m=>f.manager.includes(m)))&&(!f.station.length||f.station.includes(d.code));}
export function filterEntries(entries:Entry[],dimensions:Dimension[],filters:PnlFilters){return entries.filter(e=>!e.deleted&&matchesDimension(dimensionFor(e.station,dimensions),filters));}
export function entryTotals(rows:Entry[]){const entries=rows.filter(e=>!e.deleted),income=entries.filter(e=>e.side==='income').reduce((n,e)=>n+e.paise,0),expense=entries.filter(e=>e.side==='expense').reduce((n,e)=>n+e.paise,0),manager=entries.filter(e=>e.side==='expense'&&e.head==='Manager share').reduce((n,e)=>n+e.paise,0),recovery=entries.filter(e=>e.recovery).reduce((n,e)=>n+e.paise,0);return {income,expense,manager,recovery,profit:income-expense,margin:income?100*(income-expense)/income:null};}
export function groupEntries(entries:Entry[],dimensions:Dimension[],by:GroupBy){const groups=new Map<string,Entry[]>();for(const e of entries){if(e.deleted)continue;const d=dimensionFor(e.station,dimensions),key=by==='station'?d.code:by==='manager'?[...new Set(d.managers)].sort().join(' / '):d[by];const list=groups.get(key)??[];list.push(e);groups.set(key,list);}return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([key,entries])=>({key,entries,stations:[...new Set(entries.map(e=>e.station))],...entryTotals(entries)}));}

/** Invoice identity includes supplier GSTIN; a displayed reference alone is not unique.
 * Rejected invoices have no posted entries, but must remain visible for review. */
export function invoiceRegister(invoices:Report['invoices'],entries:Entry[],dimensions:Dimension[],filters:PnlFilters,station=''){
 const companyView=!station&&Object.values(filters).every(values=>!values.length);
 return invoices.filter(invoice=>{
  if(companyView)return true;
  const linked=entries.filter(entry=>entry.id.startsWith(`invoice:${invoice.key}:`));
  const bases=[...new Set(linked.length?linked.map(entry=>entry.station):[invoice.baseStation||invoice.station])];
  return bases.some(code=>(!station||code===station)&&matchesDimension(dimensionFor(code,dimensions),filters));
 });
}
/** Source presence is separate from the arithmetic result. HO alone is not operating-cost evidence. */
export function entryCoverage(rows:Entry[]){
 const entries=rows.filter(e=>!e.deleted),stations=[...new Set(entries.map(e=>e.station))];
 return {
  missingIncome:stations.filter(station=>entries.some(e=>e.station===station&&e.side==='expense')&&!entries.some(e=>e.station===station&&e.side==='income'&&!e.recovery)),
  missingExpenses:stations.filter(station=>entries.some(e=>e.station===station&&e.side==='income'&&!e.recovery)&&!entries.some(e=>e.station===station&&e.side==='expense'&&!e.id.startsWith('ho-allocation:'))),
 };
}
