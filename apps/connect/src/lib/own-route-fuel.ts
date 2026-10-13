import { kilometreRate, routeFuelForDay, type RouteDistanceContext, type DailyRouteFuel } from '../../../../src/lib/workforce-route-distance.ts';
export function ownRouteFuel(context:RouteDistanceContext,workforceId:string,mappings:any[],activity:Array<{mappingId:string;date:string}>) {
  const results:DailyRouteFuel[]=[];
  const used=new Set<string>();
  for(const mapping of mappings){
    const rate=kilometreRate(mapping);if(rate===null)continue;
    const dates=new Set([...activity.filter(r=>r.mappingId===mapping.id).map(r=>r.date),...context.rows.filter(r=>r.mapping_id===mapping.id).map(r=>r.work_date),...context.manual.filter(r=>r.station_id===mapping.station_id).map(r=>r.work_date)]);
    for(const date of [...dates].sort()){
      if(date<mapping.effective_from||(mapping.effective_to&&date>mapping.effective_to))continue;
      const fuel=routeFuelForDay(context,{workforceId,stationId:mapping.station_id,mappingId:mapping.id,date,rate,hasActivity:activity.some(a=>a.mappingId===mapping.id&&a.date===date)});
      if(!fuel)continue;
      const key=`${mapping.station_id}|${date}`;
      if(used.has(key))throw new Error('Overlapping kilometre payment mappings. Contact Workforce.');
      used.add(key);results.push(fuel);
    }
  }
  return results;
}
