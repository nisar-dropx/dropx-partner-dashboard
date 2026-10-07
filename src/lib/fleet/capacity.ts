import type {FleetControlData} from '../fleet-control';
import {normalizeFleetOperatingPolicy} from './operating-policy';
/** Readiness is current; spend is the selected history. No invented shipment/van capacity. */
export function stationCapacity(data:FleetControlData,from:string,to:string) {
 const policy=normalizeFleetOperatingPolicy(data.settings.operatingPolicy);
 const terminal=new Set(data.vehicleStatuses.filter(s=>s.isTerminal).map(s=>s.key));
 const operational=new Set(data.vehicleStatuses.filter(s=>s.isOperational).map(s=>s.key));
 if(!data.vehicleStatuses.length){['sold','returned','disposed'].forEach(v=>terminal.add(v));operational.add('active');}
 const eligible=data.vehicles.filter(v=>!terminal.has(v.status));
 const codes=[...new Set([...data.stationOptions.map(s=>s.code),...eligible.map(v=>v.stationCode)])].filter(Boolean).sort();
 return codes.map(code=>{
  const vehicles=eligible.filter(v=>v.stationCode===code),deployed=vehicles.filter(v=>v.deploymentStatus==='deployed');
  const ready=deployed.filter(v=>operational.has(v.status)).length,target=policy.stationVehicleTargets?.[code]??null;
  const requests=data.adHocRows.filter(r=>r.stationCode===code&&r.date>=from&&r.date<=to&&!['rejected','cancelled','draft'].includes(r.approvalStatus.toLowerCase()));
  const vans=requests.filter(r=>r.requestType==='Van'),drivers=requests.filter(r=>r.requestType==='Driver');
  return {code,assigned:vehicles.length,ready,target,shortfall:target==null?null:Math.max(0,target-ready),unavailable:deployed.length-ready,
    owned:vehicles.filter(v=>v.ownershipType==='own').length,partners:vehicles.filter(v=>v.ownershipType!=='own').length,
    overdueService:vehicles.filter(v=>v.ownershipType==='own'&&v.nextServiceDate&&v.nextServiceDate<data.today).length,
    vanRequests:vans.length,vanAmount:vans.reduce((sum,r)=>sum+r.amount,0),driverRequests:drivers.length,driverAmount:drivers.reduce((sum,r)=>sum+r.amount,0)};
 }).sort((a,b)=>(b.shortfall??0)-(a.shortfall??0)||b.vanAmount-a.vanAmount||a.code.localeCompare(b.code));
}
