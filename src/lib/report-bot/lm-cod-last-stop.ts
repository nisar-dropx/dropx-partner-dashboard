/** Delivery outcomes only: customer-return drop-offs and pickup events are not DA delivery completion. */
export function lastDeliveryStop(payload:any,driver:string,day:string,now=Date.now()){
 const d=payload?.itineraryDetails||payload;if(d?.transporterId!==driver)return null;
 const tasks=(d.stops||[]).flatMap((s:any)=>s.tasks||[]).concat((d.inactiveTasks||[]).filter((t:any)=>(t.domainMap?.deviceOperator||t.domainMap?.OPERATOR||t.transporterId)===driver));
 const outcomes=new Set(['DELIVERED','DELIVERY_ATTEMPTED','DELIVERY_FAILED','REJECTED','DELIVERY_REJECTED']);
 const stops=tasks.flatMap((t:any)=>{
  const owner=t.domainMap?.deviceOperator||t.domainMap?.OPERATOR||t.transporterId||d.transporterId;
  if(owner!==driver||t.taskType!=='DROP_OFF'||t.customerReturn||t.customerReturnTaskFlag||t.firstLegTaskFlag||t.deliverToStoreTaskFlag||t.deliverToHubTaskFlag)return [];
  const point=[t.executionGeocode?.latitude,t.executionGeocode?.longitude];
  if(!point.every(n=>typeof n==='number'&&Number.isFinite(n))||Math.abs(point[0])>90||Math.abs(point[1])>180)return [];
  // The execution geocode belongs to the current task outcome, not an earlier event.
  if(!outcomes.has(t.taskState))return [];
  const raw=Number(t.actualExecutionTime),at=raw>1e15?raw/1000:raw<1e12?raw*1000:raw;
  return Number.isFinite(at)&&at>0&&at<=now+60000&&new Date(at+19800000).toISOString().slice(0,10)===day?[{at,point}]:[];
 }).sort((a:{at:number},b:{at:number})=>b.at-a.at);
 return stops[0]||null;
}
