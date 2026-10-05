import { unstable_cache } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { loadShipmentSizeRule } from '@/lib/ops-pulse/capacity';
import { shiftDay, shipmentSize, groupedInbound, type RoutedInbound, type SizeFact, volumeBaseline, type PaymentVolume, type VolumeDay } from '@/lib/payment-volume';

// Call only after checking the company's payment permission and station scope.
export const loadPaymentVolume = unstable_cache(async (company: string, station: string, date: string, today: string): Promise<PaymentVolume> => {
  const db = supabaseAdmin;
  if (!db) throw new Error('Volume data is temporarily unavailable.');
  const from = shiftDay(date, -28);
  const stationRows=await db.from('stations').select('id,station_code,parent_station_id,is_active,inbound_requires_destination,location_models(code)').eq('company_id',company);
  if(stationRows.error)throw new Error('Unable to load station group.');
  const parent=stationRows.data.find(s=>s.station_code===station);
  const requireDestination = parent?.inbound_requires_destination !== false;
  const groupStations=[station,...stationRows.data.filter(s=>s.is_active&&s.parent_station_id===parent?.id&&((Array.isArray(s.location_models)?s.location_models[0]:s.location_models) as {code?:string}|null)?.code==='XPT').map(s=>s.station_code)];
  const [daily,latestInbound,ruleResult,fleetResult,statusResult,sources,designations,availability]=await Promise.all([
    db.rpc('capacity_station_daily',{p_company_id:company,p_station_codes:groupStations,p_from:from,p_to:date}),
    db.from('inbound_shipment_facts').select('snapshot_at').eq('company_id',company).in('station_code',groupStations).order('snapshot_at',{ascending:false}).limit(1),
    loadShipmentSizeRule(company),
    db.from('fleet_vehicles').select('id,vehicle_no,model,source_id,ownership_type,status,deployment_status,deployment_date,da_name,vendor_name,current_location_label').eq('company_id',company).in('station_code',groupStations).order('vehicle_no'),
    db.from('fleet_vehicle_status_master').select('status_key,label,is_operational,is_terminal').eq('company_id',company),
    db.from('fleet_vehicle_sources').select('id,designation_id').eq('company_id',company),
    db.from('designations').select('id,code,name').eq('company_id',company),
    db.from('fleet_vehicle_day_availability').select('vehicle_id,status').eq('company_id',company).eq('work_date',today).is('revoked_at',null)
  ]);
  if(daily.error||latestInbound.error)throw new Error('Unable to load station history. Please retry.');
  const rows=(daily.data??[]) as Array<{station_code:string;work_date:string;inbound:number|string;delivered:number|string;volume_source:string}>;
  type Fact=RoutedInbound & SizeFact & {expected_arrival_date:string};
  const evidence=new Map<string,Fact[]>();
  for(let offset=0;;offset+=1000){
   const result=await db.from('inbound_shipment_facts').select('id,tracking_id,station_code,expected_arrival_date,package_count,snapshot_at,actual_weight_kg,length_cm,width_cm,height_cm,cubic_volume_cm3,raw_payload')
    .eq('company_id',company).in('station_code',groupStations).or(`and(expected_arrival_date.gte.${from},expected_arrival_date.lte.${date}),expected_arrival_date.eq.${today}`).order('id').range(offset,offset+999);
   if(result.error)throw new Error('Unable to load inbound station evidence.');
   for(const row of result.data??[]){const list=evidence.get(row.expected_arrival_date)??[];list.push(row as Fact);evidence.set(row.expected_arrival_date,list);}
   if((result.data?.length??0)<1000)break;
   if(offset>=99000)throw new Error('Inbound evidence exceeds the report limit.');
  }
  const days:VolumeDay[]=Array.from({length:29},(_,i)=>{
   const workDate=shiftDay(from,i),verified=groupedInbound(evidence.get(workDate)??[],groupStations,requireDestination);
   const delivered=rows.filter(r=>r.work_date===workDate&&/Delivered detail|Daily shipment count/i.test(r.volume_source));
   return {date:workDate,inbound:verified.inbound,inboundUnverified:verified.unverified,delivered:delivered.length?delivered.reduce((sum,r)=>sum+Number(r.delivered),0):null,deliverySource:delivered.length?'Imported deliveries':'No source'};
  });
  const requestedGroup=groupedInbound(evidence.get(date)??[],groupStations,requireDestination);
  let snapshotAt:string|null=null,bulky=0,classified=0,packages=0,routingVerified=0;
  for(const row of requestedGroup.accepted as Fact[]){
    const count=Math.max(1,Number(row.package_count)||1);packages+=count;
    if(row.snapshot_at&&(!snapshotAt||row.snapshot_at>snapshotAt))snapshotAt=row.snapshot_at;
    if(row.raw_payload?.serving_station_code)routingVerified+=count;
    const size=shipmentSize(row,ruleResult.error?null:ruleResult.rule);if(size!=='unknown')classified+=count;if(size==='bulky')bulky+=count;
  }
  const currentInbound=groupedInbound(evidence.get(today)??[],groupStations,requireDestination).inbound;
  const statuses = new Map((statusResult.data ?? []).map(row => [row.status_key, row]));
  const sourceLabels: Record<string, string> = { own: 'Own', odcd: 'ODCD', rented: 'Van Rented', van_vendor: 'Van Vendor', vendor: 'Van Vendor' };
  const vehicles = (fleetResult.data ?? []).filter(row => !statuses.get(row.status)?.is_terminal).map(row => {
    const dailyStatus=availability.data?.find(d=>d.vehicle_id===row.id)?.status;
    const status = statuses.get(dailyStatus||row.status);
    const source=sources.data?.find(s=>s.id===row.source_id);const designation=designations.data?.find(d=>d.id===source?.designation_id);
    const deployed = row.deployment_status === 'deployed' && (!row.deployment_date || row.deployment_date <= today);
    return { id: row.id, number: row.vehicle_no, model: row.model || 'Model not recorded', source: designation?.name || sourceLabels[row.ownership_type] || row.ownership_type || 'Not recorded',
      partner: row.ownership_type === 'odcd' ? row.da_name || 'DA not recorded' : row.ownership_type === 'own' ? 'DropX' : row.vendor_name || 'Vendor not recorded',
      status: status?.label || dailyStatus || row.status || 'Unknown', operational: deployed && !dailyStatus && Boolean(status?.is_operational), deployed, location: row.current_location_label || 'Not recorded' };
  });
  return { station, date, today, todayInbound: currentInbound, requireDestination, groupStations,breakup:requestedGroup.breakup,unallocated:requestedGroup.unallocated,
    days, ...volumeBaseline(days, date), snapshotAt, latestInboundSnapshot: latestInbound.data?.[0]?.snapshot_at ?? null,
    bulky: days.at(-1)?.inbound != null && classified ? bulky : null,
    classified: days.at(-1)?.inbound != null ? classified : 0, packages: days.at(-1)?.inbound != null ? packages : 0, routingVerified,
    vehicles, fleetError: fleetResult.error || statusResult.error || availability.error || sources.error || designations.error ? 'Fleet availability could not be verified.' : null,
    sizeRule: ruleResult.error ? null : ruleResult.rule,
    refreshedAt: new Date().toISOString() };
}, ['payment-volume-dock-arrivals-v5'], { revalidate: 60 });

export function paymentVolumeToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
