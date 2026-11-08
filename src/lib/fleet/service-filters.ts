import {facetRows} from '../dependent-filters';
import {vehicleIsOperational, vehicleIsTerminal} from './vehicle-status-policy';
import {vehicleTypeKey} from './vehicle-type';
import type {FleetControlData, FleetControlVehicle, FleetServiceRecord} from '../fleet-control';

type Key = 'station'|'region'|'model'|'type'|'status';
type Context = Record<Key,string>;
export type ServiceFilterSelection = {stations:string[];regions:string[];models:string[];ownership:string[];statuses:string[];search:string;date:string};
export function serviceFilterFacets(data:FleetControlData, vehicles:FleetControlVehicle[], view:string, selected:ServiceFilterSelection, planned:Map<string,FleetServiceRecord>, latest:Map<string,FleetServiceRecord>) {
  const stationIndex=new Map(data.stationOptions.map(s=>[s.code,s]));
  const vehicleIndex=new Map(vehicles.map(v=>[v.id,v]));
  const region=(station:string)=>stationIndex.get(station)?.region||'Unassigned region';
  const dimensions={
    station:{selected:selected.stations,values:(r:Context)=>r.station},
    region:{selected:selected.regions,values:(r:Context)=>r.region},
    model:{selected:view==='bills'?[]:selected.models,values:(r:Context)=>r.model},
    type:{selected:['daily_status','non_operational'].includes(view)?selected.ownership:[],values:(r:Context)=>r.type},
    status:{selected:selected.statuses,values:(r:Context)=>r.status}
  };
  const query=selected.search.trim().toLowerCase();
  const contains=(text:string)=>!query||text.toLowerCase().includes(query);
  const vehicleContext=(v:FleetControlVehicle):Context=>({station:v.stationCode,region:region(v.stationCode),model:v.model||'Model not recorded',type:vehicleTypeKey(v),status:v.status});
  if(view!=='daily_status') {
    let rows:Context[];
    if(view==='history') rows=data.serviceHistory.filter(r=>r.status!=='scheduled'&&contains(`${r.vehicleNo} ${r.serviceType} ${r.vendorName} ${r.stationCode}`)).map(r=>({station:r.stationCode,region:region(r.stationCode),model:vehicleIndex.get(r.vehicleId)?.model??'',type:'',status:r.status}));
    else if(view==='bills') rows=data.payments.filter(r=>contains(`${r.requestNo} ${r.head} ${r.stationCode} ${r.remarks}`)).map(r=>({station:r.stationCode,region:region(r.stationCode),model:'',type:'',status:r.statusLabel}));
    else rows=vehicles.filter(v=>v.ownershipType==='own'&&!vehicleIsTerminal(v.status,data.vehicleStatuses)&&(view!=='non_operational'||!vehicleIsOperational(v.status,data.vehicleStatuses))&&contains(`${v.vehicleNo} ${v.model} ${v.stationCode} ${v.statusComment}`)).map(v=>{
      const row=vehicleContext(v);
      if(view==='schedule') {
        const date=planned.get(v.id)?.serviceDate??latest.get(v.id)?.nextServiceDate??v.nextServiceDate;
        const days=date?Math.round((Date.parse(`${date.slice(0,10)}T00:00:00Z`)-Date.parse(`${data.today}T00:00:00Z`))/86400000):null;
        row.status=days===null?'not_planned':days<0?'overdue':days<=data.settings.serviceWarningDays?'due_soon':'planned';
      }
      return row;
    });
    return facetRows(rows,dimensions);
  }
  // "Affected" is calculated per station AFTER vehicle filters. Evaluate each
  // dimension without itself, using compact groups, not expanded report records.
  const result=facetRows<Context,Key>([],dimensions);
  const inSelection=(key:Key,value:string,ignore:Key)=>key===ignore||!dimensions[key].selected.length||dimensions[key].selected.includes(value);
  for(const key of Object.keys(dimensions) as Key[]) {
    const relevant=vehicles.filter(v=>!vehicleIsTerminal(v.status,data.vehicleStatuses)&&inSelection('station',v.stationCode,key)&&inSelection('region',region(v.stationCode),key)&&inSelection('model',v.model||'Model not recorded',key)&&inSelection('type',vehicleTypeKey(v),key)&&contains(`${v.vehicleNo} ${v.model} ${v.stationCode} ${v.statusComment}`));
    const stationRegions=new Map<string,Set<string>>();
    for (const vehicle of relevant) {
      const regions=stationRegions.get(vehicle.stationCode)??new Set<string>();
      regions.add(region(vehicle.stationCode));
      stationRegions.set(vehicle.stationCode,regions);
    }
    const stations=new Set(stationRegions.keys());
    const vans=data.adHocRows.filter(r=>r.date===selected.date&&r.requestType==='Van'&&(r.source==='Cashbook'||['approved','final_approved','processing','processed','paid'].includes(r.approvalStatus))&&inSelection('station',r.stationCode,key)&&inSelection('region',r.region,key)&&(key==='model'||!selected.models.length||stations.has(r.stationCode))&&(key==='type'||!selected.ownership.length||stations.has(r.stationCode))&&(!query||stations.has(r.stationCode)));
    const affected=new Set([...relevant.filter(v=>!vehicleIsOperational(v.status,data.vehicleStatuses)).map(v=>v.stationCode),...vans.map(r=>r.stationCode)]);
    const allowedStation=(code:string)=>key==='status'||!selected.statuses.includes('affected')||affected.has(code);
    if(key==='status') {if(affected.size)result.available.status.add('affected');continue;}
    const affectedOnly=selected.statuses.includes('affected');
    const vanStations=new Set(vans.map(v=>v.stationCode));
    for(const v of relevant) {
      let eligible=allowedStation(v.stationCode);
      if(affectedOnly&&(key==='model'||key==='type')) eligible=!vehicleIsOperational(v.status,data.vehicleStatuses)||vanStations.has(v.stationCode);
      if(affectedOnly&&key==='region') eligible=!vehicleIsOperational(v.status,data.vehicleStatuses);
      if(eligible) result.available[key].add(vehicleContext(v)[key]);
    }
    if(key==='station'||key==='region') for(const van of vans) if(allowedStation(van.stationCode)) {
      // Historical ad-hoc regions can differ from current vehicle placement.
      if(key==='region'&&(selected.models.length||selected.ownership.length||query)&&!stationRegions.get(van.stationCode)?.has(van.region)) continue;
      const value=key==='station'?van.stationCode:van.region;if(value)result.available[key].add(value);
    }
  }
  return result;
}
