import type { CodCheck, CodStatusSnapshot } from './cod-status';

type Reconciliation = NonNullable<CodStatusSnapshot['reconciliation']['data']>;
const round = (n:number) => Math.round(n * 100) / 100;
const present = (n:number) => Math.abs(n) >= 0.01;
export function collectionDay(value:number | null | undefined, now = new Date()):string | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= Date.UTC(2000,0,1) && value <= now.getTime()
    ? new Date(value + 330*60000).toISOString().slice(0,10) : null;
}
export function validCollectionDate(value:string, today:string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value > today) return false;
  const ms=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0,10)===value;
}
/** Filter the current outstanding balance by its original collection date.
 * This is deliberately not a reconstruction of a historical closing balance. */
export function reconciliationView(data:Reconciliation | null | undefined, selectedDate='', dueTime:string | null=null, now=new Date()) {
  const today=new Date(now.getTime()+330*60000).toISOString().slice(0,10);
  let todayAmount=0, priorAmount=0, unknownAmount=0, unknownDrivers=0;
  const drivers:Reconciliation['drivers']=[];
  const dateTotals=new Map<string,number>();
  for(const driver of data?.drivers || []) {
    const packages=driver.packages || [];
    let datedAmount=0;
    const chosen=packages.filter(p=>{
      const date=collectionDay(p.collectedAt,now);
      if(date) {
        datedAmount+=p.amount;
        dateTotals.set(date,round((dateTotals.get(date)||0)+p.amount));
        if(date===today) todayAmount+=p.amount; else priorAmount+=p.amount;
      }
      return !selectedDate || (selectedDate==='undated' ? !date : date===selectedDate);
    });
    const gap=round(driver.pendingAmount-datedAmount);
    const incomplete=present(gap) || packages.some(p=>present(p.amount) && !collectionDay(p.collectedAt,now));
    if(incomplete) {unknownDrivers++;unknownAmount+=gap;}
    const pendingAmount=!selectedDate ? driver.pendingAmount : selectedDate==='undated' ? gap : round(chosen.reduce((sum,p)=>sum+p.amount,0));
    if(present(pendingAmount) || chosen.some(p=>present(p.amount))) drivers.push({...driver,packages:chosen,pendingAmount});
  }
  todayAmount=round(todayAmount);priorAmount=round(priorAmount);unknownAmount=round(unknownAmount);
  const amount=round(drivers.reduce((sum,d)=>sum+d.pendingAmount,0));
  const due=/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime || '') ? Date.parse(`${today}T${dueTime}:00+05:30`) : null;
  const priorInView=(!selectedDate ? priorAmount : selectedDate<today && selectedDate!=='undated' ? amount : 0);
  const todayInView=(!selectedDate || selectedDate===today) ? todayAmount : 0;
  const dateInvalid=selectedDate && selectedDate!=='undated' && !validCollectionDate(selectedDate,today);
  const missing=!!data?.pendingCount && !(data.drivers?.length);
  let check:CodCheck;
  if(!data?.complete || missing || dateInvalid) check={tone:'unavailable',label:'Needs verification',reason:'The source or collection date could not be verified.'};
  else if(priorInView>0.005) check={tone:'attention',label:'Earlier-day cash overdue',reason:'Cash collected before today is still unreconciled.'};
  else if(todayInView>0.005 && due!==null && now.getTime()>=due) check={tone:'attention',label:'Today’s reconciliation overdue',reason:`Cash remains with associates after the ${dueTime} IST closing deadline.`};
  else if(unknownDrivers || amount<0) check={tone:'unavailable',label:'Collection date needs verification',reason:`${unknownDrivers || drivers.length} DA balance${(unknownDrivers || drivers.length)===1?'':'s'} cannot be fully attributed to a collection date. Review undated cash.`};
  else if(todayInView>0.005) check={tone:'active',label:'Today · collection in progress',reason:due!==null?`Normal during delivery hours. Reconcile by ${dueTime} IST.`:'Today’s cash. Set a DA reconciliation deadline in COD Pickup Master for evening alerts.'};
  else check={tone:'clear',label:selectedDate?'No pending cash for this date':'100% reconciled',reason:selectedDate?'No currently outstanding DA cash is attributed to this collection date.':'All returned DA balances are reconciled.'};
  return {check,drivers,amount,pendingCount:drivers.length,todayAmount,priorAmount,unknownAmount,unknownDrivers,dateTotals:[...dateTotals].sort(([a],[b])=>a.localeCompare(b)),dueTime};
}
