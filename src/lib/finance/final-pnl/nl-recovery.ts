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

/** Approved receipt evidence and payroll settle the same case. Recognise only
 * the increase in cumulative confirmed recovery, never the plan's assigned sum. */
export function nlReceiptEvidence(month:string,cases:Row[],plans:Row[],evidence:ReturnType<typeof nlRecoveryEvidence>){
 const postedByCase=new Map(evidence.postedByCase),issues=[...evidence.issues];let entries=[...evidence.entries];
 const byCase=new Map(cases.map(c=>[`${c.month}:${c.case_key}`,c]));
 for(const plan of plans){
  if(plan.is_deleted||plan.outcome_code!=='already_recovered'||plan.approval_status!=='approved')continue;
  const c=byCase.get(`${plan.month}:${plan.case_key}`),d=plan.recovery_details;
  if(!c||c.lifecycle_status==='needs_review'||!d||paise(plan.source_amount)!==paise(c.amount)||(c.report!=='slp'&&plan.source_status!==c.source_status))continue;
  const date=String(d.received_date??''),reference=String(d.receipt_reference??'').trim();
  if(!/^20\d{2}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||reference.length<5)continue;
  if(date.slice(0,7)>month)continue;
  const amount=paise(d.received_amount);if(amount<=0||amount!==paise(c.amount))continue;
  const caseKey=`nl:${c.month}:${c.case_key}`,payroll=postedByCase.get(caseKey)??0;
  const current=entries.filter(e=>e.caseKey===caseKey).reduce((n,e)=>n+e.paise,0),before=payroll-current;
  const recognized=Math.max(payroll,amount)-Math.max(before,date.slice(0,7)<month?amount:0);
  postedByCase.set(caseKey,Math.max(payroll,amount));
  entries=entries.filter(e=>e.caseKey!==caseKey);
  if(recognized>0)entries.push({id:`recovery:nl:receipt:${caseKey}:${month}`,month,station:c.station_code,sourceStation:c.station_code,side:'income',head:'Loss recovery',description:`Approved recovery receipt · ${c.case_key} · payroll overlap counted once`,paise:recognized,source:'Ops Pulse approved recovery receipt',reference,date,recovery:true,caseKey});
  if(payroll>0)issues.push(`${c.station_code}: receipt and payroll evidence overlap for ${c.case_key}; recovery is counted once using cumulative confirmed amounts.`);
 }
 return {...evidence,entries,postedByCase,issues};
}
