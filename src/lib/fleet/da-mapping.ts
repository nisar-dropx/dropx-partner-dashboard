export type RiderOption={id:string;name:string;lastSeen:string|null};
export type VehicleDA={id:string;vehicle_no:string;model:string|null;da_name?:string|null;vendor_name?:string|null;station_code:string;ownership_type:string;status:string;sourceCode:string;sourceName:string};
export type ConfirmedDA={id:string;vehicle_id:string;provider_employee_id:string;name:string;remarks:string;updated_at:string;delivered:number|null;cReturn:number|null;swa:number|null};
export type DefaultDA={id:string;vehicle_id:string;station_code:string;provider_employee_id:string;name:string;updated_at:string};
export type MappingData={date:string;today:string;station:string;stations:{code:string;name:string}[];vehicles:VehicleDA[];options:RiderOption[];assignments:ConfirmedDA[];confirmations:{vehicle_id:string;updated_at:string;remarks:string}[];defaults:DefaultDA[];alertFrom?:string;recentDays:number;latestFeed:string|null;warning?:string;canEdit:boolean;canDefaults:boolean;canPolicy:boolean};
export const riderKey=(value:string)=>value.trim().toUpperCase();
export function recentRiders(rows:{provider_employee_id:string;provider_employee_name:string|null;work_date:string}[]):RiderOption[]{
 const found=new Map<string,RiderOption>();
 for(const row of [...rows].sort((a,b)=>b.work_date.localeCompare(a.work_date))){const id=riderKey(row.provider_employee_id||'');if(id&&!found.has(id))found.set(id,{id,name:row.provider_employee_name?.trim()||id,lastSeen:row.work_date});}
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
