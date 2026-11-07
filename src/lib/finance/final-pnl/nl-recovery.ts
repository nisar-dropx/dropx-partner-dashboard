import type {Entry} from './model';
const paise=(value:unknown)=>{const n=Number(value);if(value==null||!Number.isFinite(n))throw Error('Invalid loss recovery amount');return Math.round(n*100);};
type Row=Record<string,any>;
type Posting={key:string;caseId:string;month:string;paise:number;confirmed:boolean;reference:string;date:string;source:string};
/** Only explicit Ops recovery keys link salary evidence to an incident. A publication
 * without approved current payroll is shown as pending, never recovery income. */
export function nlRecoveryEvidence(month:string,cases:Row[],rawPublications:Row[],finalPublications:Row[],hrRuns:Row[],hrPeople:Row[],hrItems:Row[]){
 const caseByKey=new Map(cases.map(c=>[`${c.month}|${c.case_key}`,c]));
 // Case identifiers may themselves contain pipes. Only the typed person reference
 // and optional installment form a suffix; the remaining key must match exactly.
 const caseForKey=(key:string)=>{const match=/^(.+)\|(?:employee|workforce|contractor):[^|]+(?:\|[1-9]\d*)?$/.exec(key);return match?caseByKey.get(match[1]):undefined;};
 const postings=new Map<string,Posting>();
 const issues:string[]=[];
 const add=(key:unknown,value:Omit<Posting,'key'|'caseId'>)=>{
  if(typeof key!=='string'||!key||!/^20\d{2}-\d{2}$/.test(value.month)||value.month>month||value.paise<=0)return;
  const c=caseForKey(key);if(!c)return;
  const old=postings.get(key),next={...value,key,caseId:`nl:${c.month}:${c.case_key}`};
  if(old?.confirmed&&next.confirmed&&(old.month!==next.month||old.paise!==next.paise))throw Error(`Conflicting confirmed payroll deductions for Ops loss ${c.case_key}. Resolve payroll evidence before refreshing.`);
  if(!old||(!old.confirmed&&next.confirmed)||(!old.confirmed&&!next.confirmed&&next.month>=old.month))postings.set(key,next);
 };
 const finalById=new Map(finalPublications.map(p=>[p.id,p]));
 const runById=new Map(hrRuns.map(r=>[r.id,r]));
 for(const p of rawPublications){
  const final=finalById.get(p.id);if(!final)continue; // cancelled/superseded publications
  const confirmed=final.payrollFinal===true;
  const verifiedKeys=new Map((final.deductions??[]).filter((d:Row)=>d.code==='LOSS_RECOVERY'&&d.recoveryKey).map((d:Row)=>[d.recoveryKey,Math.abs(paise(d.amount))]));
  for(const d of p.deductions??[]){if(d.code!=='LOSS_RECOVERY'||!d.recoveryKey)continue;const amount=Math.abs(paise(d.amount));
   add(d.recoveryKey,{month:p.period_start.slice(0,7),paise:amount,confirmed:confirmed&&verifiedKeys.get(d.recoveryKey)===amount,reference:p.id,date:p.period_end,source:'Ops Pulse / Workforce payroll'});
  }
 }
 const personById=new Map(hrPeople.map(p=>[p.id,p]));
 for(const item of hrItems){if(item.code!=='OPS_LOSS_RECOVERY')continue;const person=personById.get(item.run_person_id),run=person&&runById.get(person.run_id);if(!run||run.status==='cancelled')continue;
  add(item.metadata?.recovery_key,{month:run.period_start.slice(0,7),paise:Math.abs(paise(item.amount)),confirmed:['approved','locked','published','paid'].includes(run.status),reference:item.id,date:run.period_end,source:'Ops Pulse / People payroll'});
 }
 const postedByCase=new Map<string,number>(),pendingByCase=new Map<string,number>(),pendingThisMonthByCase=new Map<string,number>();
 const entries:Entry[]=[];
 for(const p of postings.values()){
  const target=p.confirmed?postedByCase:pendingByCase;target.set(p.caseId,(target.get(p.caseId)??0)+p.paise);
  if(!p.confirmed&&p.month===month)pendingThisMonthByCase.set(p.caseId,(pendingThisMonthByCase.get(p.caseId)??0)+p.paise);
  if(p.confirmed&&p.month===month){const c=caseForKey(p.key)!;
   entries.push({id:`recovery:nl:${p.key}`,month,station:c.station_code,sourceStation:c.station_code,side:'income',head:'Loss recovery',description:`${String(c.report||'NL').toUpperCase()} loss · ${c.case_key} · salary ${p.month}`,paise:p.paise,source:p.source,reference:p.reference,date:p.date,recovery:true,caseKey:p.caseId,payrollMonth:p.month});
  }
 }
 for(const c of cases){if((postedByCase.get(`nl:${c.month}:${c.case_key}`)??0)>paise(c.amount))issues.push(`Confirmed recovery exceeds the current loss-register amount for ${c.case_key}; review source changes and payroll before closing.`);}
 return {entries,postedByCase,pendingByCase,pendingThisMonthByCase,issues};
}
export function lossCategory(report:unknown,details:unknown):string{
 const record=details&&typeof details==='object'?details as Row:{};
 const text=[record.category,record.loss_type,record.type,record.sub_category].filter(v=>typeof v==='string').join(' ').toLowerCase();
 if(/cash on delivery|cod loss|cod shortage|cash shortage/.test(text))return 'COD loss';
 return String(report||'').toLowerCase()==='slp'?'Package loss (SLP)':'Package loss (NL)';
}
