import type {Dimension,Entry} from './model';
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
export function modelLabel(code:string){return ({NOW:'Amazon Now',AMXL:'Amazon XL',MDH:'Flipkart MDH',ODH:'Flipkart ODH',FM:'Meesho FM',HO:'Head office'} as Record<string,string>)[code]??code;}
export function statementHead(e:Entry){
 if(e.side!=='expense')return e.head;
 if(/^vehicle rent\s*[·-]/i.test(e.head))return 'Vehicle rent';
 if(/^vehicle run(?:\s*[·-]|$)/i.test(e.head))return 'Vehicle run';
 if(/^ad[ -]?hoc van$/i.test(e.head.trim()))return 'Adhoc Van';
 return e.head;
}
export type GroupBy='region'|'state'|'model'|'manager'|'station';
export function dimensionFor(code:string,dimensions:Dimension[]):Dimension{return dimensions.find(d=>d.code===code)??{code,name:code,region:'Unassigned',state:'Unassigned',model:'Unassigned',cluster:'Unassigned',managers:['Unassigned'],isHo:/^HO(?:_|$)/i.test(code)};}
export function matchesDimension(d:Dimension,f:PnlFilters){return (!f.region.length||f.region.includes(d.region))&&(!f.state.length||f.state.includes(d.state))&&(!f.model.length||f.model.includes(d.model))&&(!f.format.length||f.format.includes(d.format||'Not applicable'))&&(!f.manager.length||d.managers.some(m=>f.manager.includes(m)))&&(!f.station.length||f.station.includes(d.code));}
export function filterEntries(entries:Entry[],dimensions:Dimension[],filters:PnlFilters){return entries.filter(e=>!e.deleted&&matchesDimension(dimensionFor(e.station,dimensions),filters));}
export function entryTotals(entries:Entry[]){const income=entries.filter(e=>e.side==='income').reduce((n,e)=>n+e.paise,0),expense=entries.filter(e=>e.side==='expense').reduce((n,e)=>n+e.paise,0),manager=entries.filter(e=>e.side==='expense'&&e.head==='Manager share').reduce((n,e)=>n+e.paise,0),recovery=entries.filter(e=>e.recovery).reduce((n,e)=>n+e.paise,0);return {income,expense,manager,recovery,profit:income-expense,margin:income?100*(income-expense)/income:null};}
export function groupEntries(entries:Entry[],dimensions:Dimension[],by:GroupBy){const groups=new Map<string,Entry[]>();for(const e of entries){const d=dimensionFor(e.station,dimensions),key=by==='station'?d.code:by==='manager'?[...new Set(d.managers)].sort().join(' / '):d[by];const list=groups.get(key)??[];list.push(e);groups.set(key,list);}return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([key,entries])=>({key,entries,stations:[...new Set(entries.map(e=>e.station))],...entryTotals(entries)}));}
