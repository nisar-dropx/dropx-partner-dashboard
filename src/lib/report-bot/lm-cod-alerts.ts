import { classifyRemittance, type CodRemittance } from "../ops-pulse/cod-status.ts";
import type { PickupPolicy } from "../ops-pulse/cod-pickup.ts";

const dayAt = (day:string,time:string) => Date.parse(`${day}T${time}:00+05:30`);
const openRemittance = (row:CodRemittance) => ["CREATED","PENDING_SUBMISSION"].includes(row.status.toUpperCase());

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
