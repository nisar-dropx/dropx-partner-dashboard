import { classifyRemittance, type CodRemittance } from "../ops-pulse/cod-status.ts";
import type { PickupPolicy } from "../ops-pulse/cod-pickup.ts";

const dayAt = (day:string,time:string) => Date.parse(`${day}T${time}:00+05:30`);
const openRemittance = (row:CodRemittance) => ["CREATED","PENDING_SUBMISSION"].includes(row.status.toUpperCase());
const clockMinutes = (time:string) => {
  const match=/^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return match ? Number(match[1])*60+Number(match[2]) : Number.NaN;
};
const istMinutes = (now:Date) => {
  const shifted=new Date(now.getTime()+330*60000);
  return shifted.getUTCHours()*60+shifted.getUTCMinutes();
};

export type OverdueRemittance = { row:CodRemittance; reason:string; dueAt:number };

/** Pickup timing comes from COD Pickup Master. The extra grace prevents an
 * alert at the exact configured pickup close and gives the station 30 minutes
 * to update the portal. */
export function overdueRemittancesAfterGrace(rows:CodRemittance[],latest:CodRemittance|null,policy:PickupPolicy|null,now=new Date(),graceMinutes=30):OverdueRemittance[] {
  if(!policy) return [];
  return rows.filter(openRemittance).flatMap(row=>{
    const check=classifyRemittance(row,latest,policy,now);
    return check.tone==="attention" && check.dueAt && now.getTime()>=check.dueAt+graceMinutes*60000
      ? [{row,reason:check.reason,dueAt:check.dueAt}]
      : [];
  });
}

export function submittedRemittanceAt(row:CodRemittance|null) {
  if(!row || row.status.toUpperCase()!=="SUBMITTED") return null;
  const value=Number.isFinite(row.submittedAt) && Number(row.submittedAt)>0 ? Number(row.submittedAt) : Number(row.updatedAt);
  return Number.isFinite(value) && value>0 ? value : null;
}

export function slipUploadOverdue(row:CodRemittance|null,now=new Date(),graceMinutes=30) {
  const submittedAt=submittedRemittanceAt(row);
  return submittedAt!==null && now.getTime()>=submittedAt+graceMinutes*60000;
}

/** COD slip reminders run from a 30-minute scheduler without spamming every
 * slot: first reminder after 30 minutes, then one reminder per hour. The
 * half-hour window ensures exactly one eligible scheduler slot per stage. */
export function slipReminderState(row:CodRemittance|null,now=new Date(),firstMinutes=30,repeatMinutes=60,schedulerWindowMinutes=30) {
  const submittedAt=submittedRemittanceAt(row);
  if(submittedAt===null) return {due:false,stage:0,elapsedMinutes:0,submittedAt:null};
  const elapsedMinutes=Math.floor((now.getTime()-submittedAt)/60000);
  if(elapsedMinutes<firstMinutes) return {due:false,stage:0,elapsedMinutes,submittedAt};
  const afterFirst=elapsedMinutes-firstMinutes;
  const stage=1+Math.floor(afterFirst/repeatMinutes);
  return {due:afterFirst%repeatMinutes<schedulerWindowMinutes,stage,elapsedMinutes,submittedAt};
}

/** Before the 10 PM closing sweep, a DA is actionable only after their most
 * recent COD delivery has aged 90 minutes. From 10 PM onward every outstanding
 * DA is shown, including rows whose source did not expose a trustworthy last
 * delivery timestamp. */
export function reconciliationDriverAlert(lastDeliveryAt:number|null,now=new Date(),graceMinutes=90,fullSweepFrom="22:00") {
  const fullSweep=istMinutes(now)>=clockMinutes(fullSweepFrom);
  const valid=typeof lastDeliveryAt==="number"&&Number.isFinite(lastDeliveryAt)&&lastDeliveryAt>0&&lastDeliveryAt<=now.getTime();
  const elapsedMinutes=valid?Math.floor((now.getTime()-lastDeliveryAt)/60000):null;
  return {due:fullSweep||(elapsedMinutes!==null&&elapsedMinutes>=graceMinutes),fullSweep,lastDeliveryAt:valid?lastDeliveryAt:null,elapsedMinutes};
}

/** Prepare Deposit begins only after station OOR reaches zero. During the
 * 7–9 PM checks it waits two hours from the last terminal delivery update; the
 * 10 PM closing sweep and later hourly checks show every still-pending station
 * whose OOR is zero, even when the closure timestamp is unavailable. */
export function prepareDepositAlertState(outOnRoad:number,closureAt:number|null,pendingAmount:number,now=new Date(),graceMinutes=120,fullSweepFrom="22:00") {
  const fullSweep=istMinutes(now)>=clockMinutes(fullSweepFrom);
  const closed=Number(outOnRoad)===0;
  const hasPending=Math.abs(Number(pendingAmount)||0)>=0.01;
  const valid=typeof closureAt==="number"&&Number.isFinite(closureAt)&&closureAt>0&&closureAt<=now.getTime();
  const elapsedMinutes=valid?Math.floor((now.getTime()-closureAt)/60000):null;
  return {due:hasPending&&closed&&(fullSweep||(elapsedMinutes!==null&&elapsedMinutes>=graceMinutes)),fullSweep,closed,closureAt:valid?closureAt:null,elapsedMinutes};
}

export function scrubAlertState(day:string,now:Date,inStationChecks:number,onRoadChecks:number,stationDue="13:00",roadDue="22:00") {
  const stationOverdue=now.getTime()>=dayAt(day,stationDue);
  const roadOverdue=now.getTime()>=dayAt(day,roadDue);
  const missingStation=stationOverdue && inStationChecks<1;
  const missingRoad=roadOverdue && onRoadChecks<1;
  return {
    pending:missingStation||missingRoad,
    rows:[
      ["At-station scrub",inStationChecks>0?"Complete":stationOverdue?"Pending · due 13:00":"Due 13:00"],
      ["On-road scrub",onRoadChecks>0?"Complete":roadOverdue?"Pending · due 22:00":"Due 22:00"],
    ] as [string,string|number][],
  };
}
