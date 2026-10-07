import { amount, decimal, scale, mgEstimate, monthEnd, subtractAmounts, parseCsv } from './pricing';

export type NowSlab = { above: number; upto: number | null; base: string; incentive: string };
export type NowRate = {
  category: string; city: string; monthly_mg: string; mg_upd: number;
  monthly_incentive: string; slabs: NowSlab[];
  slab_mode: 'progressive' | 'all_excess' | 'unconfirmed';
  effective_from: string; effective_to?: string | null; source: string;
};
export type NowStore = { station_code: string; category: string; city: string; rate_key: string; effective_from: string; effective_to?: string | null; monthly_mg_override?: string | null };
export type NowVolume = { station_code: string; month: string; through_date: string; units: number; incentive_percent: number | null; note: string; revision?: number };
export type BusinessMasterKind = 'now_rate' | 'now_store' | 'cost_head' | 'contract' | 'overhead' | 'insight' | 'reporting_region';
export type MasterRecord = { id: string; kind: BusinessMasterKind; key: string; label: string; data: Record<string, any>; revision: number; deleted_at: string | null; updated_at: string };
export type CostContract = { head_key: string; station_code: string; vendor: string; amount: string; frequency: 'monthly' | 'annual' | 'once'; effective_from: string; effective_to?: string | null; settlement_heads: string[]; reference: string };
export type OverheadRule = { station_code: string; mode: 'regional' | 'corporate'; recipient_codes: string[]; effective_from: string; effective_to?: string | null };
export const roundMoney = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export function validDate(v: string) { return /^20\d\d-\d\d-\d\d$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v; }
export function dateRange(from: string, to: string) { if(!validDate(from)||!validDate(to)||from>to||Date.parse(to)-Date.parse(from)>366*86400000) throw Error('Choose a valid period up to one year.'); return Array.from({length:Math.round((Date.parse(to)-Date.parse(from))/86400000)+1},(_,i)=>new Date(Date.parse(from)+i*86400000).toISOString().slice(0,10)); }
export function effectiveOn(record: {effective_from:string;effective_to?:string|null}, date:string) { return record.effective_from<=date && (!record.effective_to||record.effective_to>=date); }
export function accrueMonthly(monthly: string, date: string) { const days=Number(monthEnd(date.slice(0,7)).slice(8)),d=Number(date.slice(8)); return Number(subtractAmounts(mgEstimate(monthly,d,days),mgEstimate(monthly,d-1,days))); }
export function contractDaily(c:CostContract,date:string) { if(!effectiveOn(c,date))return 0; if(c.frequency==='once')return date===c.effective_from?Number(c.amount):0; return accrueMonthly(c.frequency==='annual'?amount(decimal(c.amount)/BigInt(12)):c.amount,date); }
const text=(v:unknown,label:string,max=200)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error(`${label} is required (up to ${max} characters).`);return v.trim();};
const money=(v:unknown,label:string)=>{const s=String(v??'');if(!/^\d{1,12}(\.\d{1,2})?$/.test(s))throw Error(`${label} must be a non-negative amount.`);return s;};
const integer=(v:unknown,label:string)=>{const n=Number(v);if(v===''||v==null||!Number.isSafeInteger(n)||n<0)throw Error(`${label} must be a non-negative whole number.`);return n;};
export function validateMaster(kind:BusinessMasterKind,value:unknown):Record<string,any> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid master record.');
  const v=value as Record<string,any>;
  if(kind==='reporting_region')return {station_code:text(v.station_code,'Station / store',40),region:text(v.region,'Region',100)};
  if(kind==='cost_head')return {description:String(v.description??'').slice(0,500)};
  if(kind==='insight')return {model:text(v.model,'Model',100),enabled:v.enabled===true};
  const effective_from=text(v.effective_from,'Effective from'),effective_to=v.effective_to?text(v.effective_to,'Effective through'):null;
  if(!validDate(effective_from)||(effective_to&&(!validDate(effective_to)||effective_to<effective_from)))throw Error('Choose valid effective dates.');
  const dated={effective_from,effective_to};
  if(kind==='now_store')return {...dated,station_code:text(v.station_code,'Store'),category:text(v.category,'Category'),city:text(v.city,'City'),rate_key:text(v.rate_key,'Rate card'),monthly_mg_override:v.monthly_mg_override==null||v.monthly_mg_override===''?null:money(v.monthly_mg_override,'MG override')};
  if(kind==='now_rate'){
    if(!['progressive','all_excess','unconfirmed'].includes(v.slab_mode))throw Error('Choose the slab calculation method.');
    const mg_upd=integer(v.mg_upd,'MG units/day'); if(!mg_upd)throw Error('MG units/day must be positive.');
    if(!Array.isArray(v.slabs)||v.slabs.length>30)throw Error('Enter up to 30 slabs.');
    let previous=mg_upd;
    const slabs=v.slabs.map((s:any,i:number)=>{const above=integer(s.above,'Slab lower bound'),upto=s.upto===''||s.upto==null?null:integer(s.upto,'Slab upper bound');if(above<previous||(upto!==null&&upto<=above)||(upto===null&&i!==v.slabs.length-1))throw Error('Slabs must be ordered, non-overlapping, with only the last unlimited.'); previous=upto??above;return {above,upto,base:money(s.base,'Base unit rate'),incentive:money(s.incentive,'Incentive unit rate')};});
    return {...dated,category:text(v.category,'Category'),city:text(v.city,'City'),monthly_mg:money(v.monthly_mg,'Monthly MG'),monthly_incentive:money(v.monthly_incentive??'0','Monthly incentive'),mg_upd,slabs,slab_mode:v.slab_mode,source:text(v.source,'Source',500)};
  }
  if(kind==='contract'){
    if(!['monthly','annual','once'].includes(v.frequency))throw Error('Choose a contract frequency.');
    if(!Array.isArray(v.settlement_heads)||v.settlement_heads.length>50||v.settlement_heads.some((h:unknown)=>typeof h!=='string'||h.length>160))throw Error('Invalid settlement heads.');
    return {...dated,head_key:text(v.head_key,'Expense head'),station_code:text(v.station_code,'Cost location'),vendor:text(v.vendor,'Vendor'),amount:money(v.amount,'Contract amount'),frequency:v.frequency,settlement_heads:[...new Set(v.settlement_heads.map((h:string)=>h.trim()).filter(Boolean))],reference:String(v.reference??'').slice(0,500)};
  }
  if(kind==='overhead'){
    if(!['regional','corporate'].includes(v.mode)||!Array.isArray(v.recipient_codes)||v.recipient_codes.some((c:unknown)=>typeof c!=='string'||c.length>40))throw Error('Choose an overhead treatment and recipient stations.');
    if(v.mode==='regional'&&!v.recipient_codes.length)throw Error('Choose regional recipient stations.');
    return {...dated,station_code:text(v.station_code,'HO location'),mode:v.mode,recipient_codes:[...new Set(v.recipient_codes)]};
  }
  throw Error('Unknown master section.');
}
export function validateNowVolume(value:unknown):NowVolume {
  const v=value as NowVolume;
  if(!v||typeof v!=='object')throw Error('Invalid volume record.');
  const month=text(v.month,'Month');monthEnd(month);
  if(!validDate(v.through_date)||!v.through_date.startsWith(month))throw Error('Data-through date must be within the selected month.');
  const incentive=v.incentive_percent==null||String(v.incentive_percent)===''?null:Number(v.incentive_percent);
  if(incentive!==null&&(!Number.isFinite(incentive)||incentive<0||incentive>100))throw Error('Earned incentive must be between 0 and 100%.');
  return {station_code:text(v.station_code,'Store'),month,through_date:v.through_date,units:integer(v.units,'Total units'),incentive_percent:incentive,note:String(v.note??'').slice(0,500)};
}
export function parseNowVolumeCsv(csv:string):NowVolume[]{
  const [headers,...rows]=parseCsv(csv); const required=['station_code','month','through_date','units'];
  if(!headers||new Set(headers).size!==headers.length||required.some(h=>!headers.includes(h))||!rows.length||rows.length>500)throw Error('Use the sample CSV with 1–500 rows.');
  const seen=new Set<string>();return rows.map((cells,i)=>{if(cells.length!==headers.length)throw Error(`Row ${i+2} has an incorrect column count.`);const v=validateNowVolume(Object.fromEntries(headers.map((h,j)=>[h.trim(),cells[j].trim()])));const key=v.station_code+'/'+v.month;if(seen.has(key))throw Error(`Duplicate store/month: ${key}`);seen.add(key);return v;});
}
/** UPD is units per day, not orders. Monthly input is cumulative units through its cutoff. */
export function nowRevenue(rate:NowRate,store:NowStore,volume:NowVolume|null,from:string,to:string) {
  const month=to.slice(0,7),daysInMonth=Number(monthEnd(month).slice(8));
  const through=volume?volume.through_date:to;
  const elapsed=Number(through.slice(8));
  const upd=volume?volume.units/elapsed:null;
  const issues:string[]=[];
  if(!volume)issues.push('Units not entered; MG-only estimate');
  if(volume?.incentive_percent==null)issues.push('Incentive not confirmed; excluded');
  const incentiveFactor=(volume?.incentive_percent??0)/100;
  let excessDaily=BigInt(0),variableIncentive=BigInt(0);
  if(upd!==null&&upd>rate.mg_upd){
    if(rate.slab_mode==='unconfirmed')issues.push('Excess-unit slab method needs confirmation');
    else{
      let uncovered=upd-rate.mg_upd;
      for(const s of rate.slabs){
        const units=Math.max(0,Math.min(upd,s.upto??upd)-Math.max(s.above,rate.mg_upd));uncovered-=units;
        if(rate.slab_mode==='progressive'){
          excessDaily+=decimal(String(units))*decimal(s.base)/scale;
          variableIncentive+=decimal(String(units))*decimal(s.incentive)/scale;
        }
      }
      if(uncovered>0.000001){issues.push('UPD falls in an unconfigured rate band; excess excluded');excessDaily=variableIncentive=BigInt(0);}
      else if(rate.slab_mode==='all_excess'){
        const s=rate.slabs.find(s=>upd>s.above&&(s.upto===null||upd<=s.upto));
        if(s){excessDaily=decimal(String(upd-rate.mg_upd))*decimal(s.base)/scale;variableIncentive=decimal(String(upd-rate.mg_upd))*decimal(s.incentive)/scale;}
      }
    }
  }
  const monthly=store.monthly_mg_override??rate.monthly_mg;
  const days=dateRange(from,to).filter(date=>date<=through&&effectiveOn(store,date)&&effectiveOn(rate,date));
  const daily=days.map(date=>{
    // Cumulative rounding across the month makes custom ranges reconcile to monthly results.
    const d=Number(date.slice(8));
    const extra=Number(subtractAmounts(amount(excessDaily*BigInt(d)),amount(excessDaily*BigInt(d-1))));
    const incExtra=Number(subtractAmounts(amount(variableIncentive*BigInt(d)*decimal(String(incentiveFactor))/scale),amount(variableIncentive*BigInt(d-1)*decimal(String(incentiveFactor))/scale)));
    const base=accrueMonthly(monthly,date), incentive=accrueMonthly(amount(decimal(rate.monthly_incentive)*decimal(String(incentiveFactor))/scale),date)+incExtra;
    return {date,base,excess:extra,incentive:roundMoney(incentive),revenue:roundMoney(base+extra+incentive),units:upd,estimatedDaily:true};
  });
  return {daily,issues,upd,mgUpd:rate.mg_upd,monthlyMg:Number(monthly),monthlyIncentive:Number(rate.monthly_incentive),excessUnits:upd===null?null:Math.max(0,upd-rate.mg_upd)*days.length,through,daysInMonth,incentivePercent:volume?.incentive_percent??null,slabMode:rate.slab_mode};
}
