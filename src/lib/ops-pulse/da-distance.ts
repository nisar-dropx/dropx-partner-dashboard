export type DistancePolicy={max_accuracy_m:number;max_speed_kmh:number;max_gap_seconds:number;max_shift_hours:number};
export type DistancePoint={lat:number;lng:number;accuracy_m:number;captured_at:string;shift_sequence:number;shift_in:string};
export function pointInShift(captured:number,now:number,inTime:number|null,open:boolean,maxHours:number){return open&&inTime!==null&&captured>=inTime&&captured<=now+10000&&captured>=now-120000&&now-inTime<=maxHours*3600000;}
export function haversine(a:DistancePoint,b:DistancePoint){const rad=Math.PI/180,dlat=(b.lat-a.lat)*rad,dlng=(b.lng-a.lng)*rad,x=Math.sin(dlat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlng/2)**2;return 6371000*2*Math.atan2(Math.sqrt(x),Math.sqrt(Math.max(0,1-x)));}
export function summarizeDistance(points:DistancePoint[],policy:DistancePolicy){
 let metres=0,coveredSeconds=0,gaps=0,rejected=0,previous:DistancePoint|null=null,anchor:DistancePoint|null=null;
 const sorted=[...points].sort((a,b)=>a.captured_at.localeCompare(b.captured_at));
 for(const p of sorted){if(!Number.isFinite(p.accuracy_m)||p.accuracy_m>policy.max_accuracy_m||p.accuracy_m<0){rejected++;previous=anchor=null;continue;}
  if(!previous){previous=anchor=p;continue;}
  const seconds=(Date.parse(p.captured_at)-Date.parse(previous.captured_at))/1000;
  if(seconds<=0)continue;
  if(p.shift_sequence!==previous.shift_sequence||p.shift_in!==previous.shift_in||seconds>policy.max_gap_seconds){gaps++;previous=anchor=p;continue;}
  const distance=haversine(previous,p);
  if(distance/seconds*3.6>policy.max_speed_kmh){rejected++;previous=anchor=null;continue;}
  coveredSeconds+=seconds;
  const movement=haversine(anchor!,p);
  // Ignore movement within the reported accuracy radius; retain the anchor to accumulate real travel.
  if(movement>Math.max(anchor!.accuracy_m,p.accuracy_m)){metres+=movement;anchor=p;}
  previous=p;
 }
 return {km:Math.round(metres)/1000,samples:points.length,coveredMinutes:Math.round(coveredSeconds/60),gaps,rejected,first:sorted[0]?.captured_at||null,last:sorted.at(-1)?.captured_at||null};
}
