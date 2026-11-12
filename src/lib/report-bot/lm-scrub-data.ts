import 'server-only';
import {fetchScrubNetwork,fetchLoadFlashBoard,fetchLoadFlashTracking,queueLoadFlashStations} from '../ops-pulse/edd-worker';
import {codCacheGet,codCachePut} from './lm-cod-journeys';
import {requireReportFreshness} from './lm-live-report';
import {scrubEddProgress,nextScrubThreshold,progressScrubAlert,type ScrubProgress} from './lm-scrub-progress';
export async function loadProgressScrub(company:string,location:string,code:string,day:string){
 const now=Date.now();
 let activity=(await fetchScrubNetwork([code])).stations.find(s=>s.stationCode===code);
 try{requireReportFreshness(activity?.fetchedAt||null,day,5,now);}catch{
  activity=(await fetchScrubNetwork([code],{refresh:true})).stations.find(s=>s.stationCode===code);
 }
 if(!activity||activity.inStation.error||activity.onRoad.error)throw new Error('Fresh scrub completion status unavailable; reminder withheld.');
 const asOf=requireReportFreshness(activity.fetchedAt,day,5);
 const today=(items:{at:string}[])=>items.filter(i=>new Date(Date.parse(i.at)+330*60000).toISOString().slice(0,10)===day).length;
 const stationChecks=today(activity.inStation.invocations),roadChecks=today(activity.onRoad.invocations);
 if(stationChecks&&roadChecks)return {asOf,complete:true,pending:false,rows:[]};
 const progress:ScrubProgress={eddClearedPct:null,roadCompletedPct:null,edd95Since:null};
 const board=(await fetchLoadFlashBoard(day,[code])).stations.find(s=>s.stationCode===code&&s.businessDate===day&&s.hasSnapshot);
 let verified=false;
 try{requireReportFreshness(board?.fetchedAt||null,day,15);verified=board?.board.stationInventoryVersion===2;}catch{}
 if(verified&&board){
  const rows=await fetchLoadFlashTracking(day,[code],{buckets:['BoardPhysical','BoardPendingToday','BoardDelivered','BoardFailed','BoardRejected','BoardOOR','BoardOther']});
  const edd=scrubEddProgress(rows.filter(r=>r.stationCode===code),day);
  progress.eddClearedPct=edd.clearedPct;
  const drivers=board.board.daDsr,total=drivers.reduce((n,d)=>n+d.total,0);
  // Failed/rejected attempts are completed stops; unknown/other remains unresolved.
  const completed=drivers.reduce((n,d)=>n+d.delivered+d.failed+d.rejected,0);
  progress.roadCompletedPct=total>0?Math.min(100,completed/total*100):null;
  const prior=await codCacheGet<{at:number}>(company,location,day,'scrub-edd95');
  progress.edd95Since=nextScrubThreshold(prior?.at??null,progress.eddClearedPct,Date.parse(board.fetchedAt!));
  if(progress.edd95Since!==(prior?.at??null))await codCachePut(company,location,day,'scrub-edd95',progress.edd95Since===null?null:{at:progress.edd95Since});
 }else await queueLoadFlashStations([code],5);
 // Missing progress never means zero pending. Only the 10 PM deadline can
 // trigger independently, after scrub completion itself was freshly checked.
 return {asOf,complete:false,...progressScrubAlert(day,now,stationChecks,roadChecks,progress)};
}
