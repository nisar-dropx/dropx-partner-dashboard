import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { FleetVehicleSource, FleetSourceDesignation } from './vehicle-sources';
export async function loadVehicleSources(companyId:string) {
 const [sources,designations]=await Promise.all([
  supabaseAdmin!.from('fleet_vehicle_sources').select('id,designation_id,ownership_type,is_active,sort_order').eq('company_id',companyId).order('sort_order'),
  supabaseAdmin!.from('designations').select('id,code,name,is_active,profile_destination').eq('company_id',companyId).order('name')
 ]);
 if(sources.error||designations.error)throw new Error(sources.error?.message||designations.error?.message);
 const options: FleetSourceDesignation[]=(designations.data??[]).map(d=>({id:d.id,code:d.code,name:d.name,isActive:d.is_active}));
 const byId=new Map(options.map(d=>[d.id,d]));
 const eligibleIds=new Set((designations.data??[]).filter(d=>['workforce','vendors'].includes(d.profile_destination)).map(d=>d.id));
 const mapped:FleetVehicleSource[]=(sources.data??[]).map(s=>{const d=byId.get(s.designation_id);return {id:s.id,designationId:s.designation_id,code:d?.code||'OWN',name:d?.name||'Own',ownershipType:s.ownership_type,isActive:s.is_active&&(!s.designation_id||Boolean(d?.isActive)),sortOrder:s.sort_order};});
 return {sources:mapped,designations:options.filter(d=>eligibleIds.has(d.id))};
}

export async function resolveVehicleSource(companyId:string,sourceId:string) {
 const {data,error}=await supabaseAdmin!.from('fleet_vehicle_sources').select('ownership_type').eq('company_id',companyId).eq('id',sourceId).maybeSingle();
 if(error||!data)throw new Error('Choose a valid vehicle source from Masters.');
 return data.ownership_type as FleetVehicleSource['ownershipType'];
}
