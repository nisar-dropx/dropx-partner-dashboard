type Tid = {trackingId:string;bucket:string;edd:string};
const dispatched = new Set(['BoardDelivered','BoardFailed','BoardRejected','BoardOOR','BoardOther']);
/** Use today's EDD cohort, not the physical inventory across all promise dates. */
export function scrubEddProgress(rows:Tid[],day:string){
 const total=new Set<string>(),pending=new Set<string>();
 for(const row of rows){
  if(!row.trackingId||row.edd!==day)continue;
  if(dispatched.has(row.bucket)||['BoardPhysical','BoardPendingToday'].includes(row.bucket))total.add(row.trackingId);
  if(row.bucket==='BoardPendingToday')pending.add(row.trackingId);
 }
 return {total:total.size,pending:pending.size,clearedPct:total.size?100*(total.size-pending.size)/total.size:null};
}
export type ScrubProgress={eddClearedPct:number|null;roadCompletedPct:number|null;edd95Since:number|null};
export function nextScrubThreshold(previous:number|null,percent:number|null,observedAt:number){
 // A new inbound wave can take the station below 95% again. Restart the grace.
 return percent!==null&&percent>=95?previous??observedAt:null;
}
export function progressScrubAlert(day:string,now:number,inStationChecks:number,onRoadChecks:number,progress:ScrubProgress){
 const stationDue=progress.eddClearedPct!==null&&progress.eddClearedPct>=95&&progress.edd95Since!==null?progress.edd95Since+2*3600000:null;
 const finalRoad=now>=Date.parse(day+'T22:00:00+05:30');
 const stationPending=inStationChecks<1&&stationDue!==null&&now>=stationDue;
 const roadPending=onRoadChecks<1&&(finalRoad||progress.roadCompletedPct!==null&&progress.roadCompletedPct>=95);
 const clock=(at:number)=>new Date(at).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'});
 const rows:[string,string|number][]=[];
 if(stationPending)rows.push(['At-station scrub','Pending'],['EDD cleared',progress.eddClearedPct!.toFixed(1)+'%'],['Scrub due',clock(stationDue!)]);
 if(roadPending)rows.push(['On-road scrub','Pending'],['Delivery rounds completed',progress.roadCompletedPct===null?'Unverified':progress.roadCompletedPct.toFixed(1)+'%'],['On-road deadline','10:00 PM']);
 return {pending:stationPending||roadPending,rows};
}
