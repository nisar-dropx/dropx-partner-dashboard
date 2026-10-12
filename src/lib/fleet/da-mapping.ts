export type RiderOption={id:string;name:string;lastSeen:string|null;stationCodes?:string[];feedStationCodes?:string[]};
export type VehicleDA={id:string;vehicle_no:string;model:string|null;da_name?:string|null;vendor_name?:string|null;station_code:string;ownership_type:string;status:string;sourceCode:string;sourceName:string};
export type ConfirmedDA={id:string;vehicle_id:string;provider_employee_id:string;name:string;remarks:string;updated_at:string;delivered:number|null;cReturn:number|null;swa:number|null};
export type DefaultDA={id:string;vehicle_id:string;station_code:string;provider_employee_id:string;name:string;updated_at:string};
export type MappingData={date:string;today:string;station:string;stations:{code:string;name:string;region?:string;clusters?:{id:string;name:string}[]|null}[];vehicles:VehicleDA[];placementRecorded?:boolean;unavailableVehicles?:VehicleDA[];dayStatuses?:{key:string;label:string}[];options:RiderOption[];assignments:ConfirmedDA[];confirmations:{vehicle_id:string;updated_at:string;remarks:string;day_status?:string|null;day_status_label?:string|null}[];defaults:DefaultDA[];alertFrom?:string;recentDays:number;latestFeed:string|null;warning?:string;clusterWarning?:string;canEdit:boolean;canDefaults:boolean;canPolicy:boolean};
export const riderKey=(value:string)=>value.trim().toUpperCase();
export function recentRiders(rows:{provider_employee_id:string;provider_employee_name:string|null;work_date:string;station_code?:string}[],parentByStation:ReadonlyMap<string,string>=new Map()):RiderOption[]{
 const found=new Map<string,RiderOption>();
 for(const row of [...rows].sort((a,b)=>b.work_date.localeCompare(a.work_date))){const id=riderKey(row.provider_employee_id||'');if(!id)continue;if(!found.has(id))found.set(id,{id,name:row.provider_employee_name?.trim()||id,lastSeen:row.work_date,...(row.station_code?{stationCodes:[]}: {})});const option=found.get(id)!;if(row.station_code){for(const code of [row.station_code,parentByStation.get(row.station_code)])if(code&&!option.stationCodes?.includes(code))(option.stationCodes??=[]).push(code);if(parentByStation.size&&!option.feedStationCodes?.includes(row.station_code))(option.feedStationCodes??=[]).push(row.station_code);}}
 return [...found.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
}
export function assignmentCounts(rows:{provider_employee_id:string;total_delivery:number|string|null;c_return:number|string|null;swa_delivery:number|string|null}[]){
 const map=new Map<string,{delivered:number|null;cReturn:number|null;swa:number|null}>();
 for(const row of rows){const id=riderKey(row.provider_employee_id);const total=map.get(id)||{delivered:0,cReturn:0,swa:0};for(const [key,source] of [['delivered','total_delivery'],['cReturn','c_return'],['swa','swa_delivery']] as const){const v=row[source];total[key]=v==null||total[key]==null?null:total[key]!+Number(v);}map.set(id,total);}
 return map;
}

/** Current daily operations follow the configurable status master and station deployment. */
export function isMappingVehicleActive(v:{status:string;deployment_status?:string|null},statuses:{status_key:string;is_operational:boolean;is_active:boolean}[]){
 const status=statuses.find(s=>s.status_key===v.status);
 return (v.deployment_status==null||v.deployment_status==='deployed')&&(status?status.is_active&&status.is_operational:v.status==='active');
}
export const isODCD=(v:VehicleDA)=>v.sourceCode.toUpperCase()==='ODCD'||v.ownership_type.toLowerCase()==='odcd';

export const riderAvailableAt=(r:RiderOption,station:string)=>!r.stationCodes||r.stationCodes.includes(station);

/** Only explicitly linked, active XPTs contribute IDs to an authorized base station. */
export function riderStationParents(parents:{id:string;code:string}[],children:{station_code:string;parent_station_id:string|null;is_active:boolean;location_models:{code?:string}|{code?:string}[]|null}[]):Map<string,string>{
 const bases=new Map(parents.map(p=>[p.id,p.code]));
 const result=new Map<string,string>();
 for(const child of children){const model=Array.isArray(child.location_models)?child.location_models[0]:child.location_models;const base=child.parent_station_id?bases.get(child.parent_station_id):undefined;
  if(child.is_active&&model?.code?.toUpperCase()==='XPT'&&base&&base!==child.station_code)result.set(child.station_code,base);
 }
 return result;
}
