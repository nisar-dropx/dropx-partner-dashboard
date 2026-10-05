import { unstable_cache } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { loadShipmentSizeRule } from '@/lib/ops-pulse/capacity';
import { shiftDay, shipmentSize, verifiedInbound, volumeBaseline, type PaymentVolume, type VolumeDay } from '@/lib/payment-volume';

// Call only after checking the company's payment permission and station scope.
export const loadPaymentVolume = unstable_cache(async (company: string, station: string, date: string, today: string): Promise<PaymentVolume> => {
  const db = supabaseAdmin;
  if (!db) throw new Error('Volume data is temporarily unavailable.');
  const from = shiftDay(date, -28);
  // Exact serving station only. Never expand to parent/CP node station lists.
  const [daily, latestInbound, ruleResult, fleetResult, statusResult] = await Promise.all([
    db.rpc('capacity_station_daily', { p_company_id: company, p_station_codes: [station], p_from: from, p_to: date }),
    db.from('inbound_shipment_facts').select('snapshot_at').eq('company_id', company).eq('station_code', station).order('snapshot_at', { ascending: false }).limit(1),
    loadShipmentSizeRule(company),
    db.from('fleet_vehicles').select('id,vehicle_no,model,ownership_type,status,deployment_status,deployment_date,da_name,vendor_name,current_location_label')
      .eq('company_id', company).eq('station_code', station).order('vehicle_no'),
    db.from('fleet_vehicle_status_master').select('status_key,label,is_operational,is_terminal').eq('company_id', company)
  ]);
  if (daily.error || latestInbound.error) throw new Error('Unable to load station history. Please retry.');
  const rows = (daily.data ?? []) as Array<{ station_code: string; work_date: string; inbound: number | string; delivered: number | string; volume_source: string }>;
  const evidence = new Map<string, Array<{ package_count: number | null; raw_payload: { serving_station_code?: string } | null }>>();
  // Aggregate only original serving-node evidence, including each BAU date.
  // Fetch compact routing fields, not full measurement payloads, for history.
  for (let offset = 0; ; offset += 1000) {
    const result = await db.from('inbound_shipment_facts')
      .select('id,expected_arrival_date,package_count,raw_payload')
      .eq('company_id', company).eq('station_code', station)
      .or(`and(expected_arrival_date.gte.${from},expected_arrival_date.lte.${date}),expected_arrival_date.eq.${today}`)
      .order('id').range(offset, offset + 999);
    if (result.error) throw new Error('Unable to verify inbound station routing. Please retry.');
    for (const row of result.data ?? []) {
      const values = evidence.get(row.expected_arrival_date) ?? [];
      values.push(row); evidence.set(row.expected_arrival_date, values);
    }
    if ((result.data?.length ?? 0) < 1000) break;
    if (offset >= 99000) throw new Error('Inbound evidence exceeds the report limit; refine the source data.');
  }
  const days: VolumeDay[] = Array.from({ length: 29 }, (_, i) => {
    const workDate = shiftDay(from, i);
    const row = rows.find(row => row.work_date === workDate && row.station_code === station);
    return { date: workDate, inbound: verifiedInbound(evidence.get(workDate) ?? [], station).inbound,
      inboundUnverified: verifiedInbound(evidence.get(workDate) ?? [], station).unverified,
      delivered: row && /Delivered detail|Daily shipment count/i.test(row.volume_source) ? Number(row.delivered) : null,
      deliverySource: row?.volume_source ?? 'No source' };
  });
  let snapshotAt: string | null = null, bulky = 0, classified = 0, packages = 0, routingVerified = 0;
  for (let offset = 0; ; offset += 1000) {
    const result = await db.from('inbound_shipment_facts')
      .select('id,package_count,snapshot_at,actual_weight_kg,length_cm,width_cm,height_cm,cubic_volume_cm3,raw_payload')
      .eq('company_id', company).eq('station_code', station).eq('expected_arrival_date', date)
      .order('id').range(offset, offset + 999);
    if (result.error) throw new Error('Unable to load inbound evidence. Please retry.');
    for (const row of result.data ?? []) {
      const count = Math.max(1, Number(row.package_count) || 1);
      if (row.raw_payload?.serving_station_code !== station) continue;
      packages += count;
      if (row.snapshot_at && (!snapshotAt || row.snapshot_at > snapshotAt)) snapshotAt = row.snapshot_at;
      if (row.raw_payload?.serving_station_code === station) routingVerified += count;
      const size = shipmentSize(row, ruleResult.error ? null : ruleResult.rule);
      if (size !== 'unknown') classified += count;
      if (size === 'bulky') bulky += count;
    }
    if ((result.data?.length ?? 0) < 1000) break;
    if (offset >= 99000) throw new Error('Inbound evidence exceeds the report limit; refine the source data.');
  }
  const currentInbound = verifiedInbound(evidence.get(today) ?? [], station).inbound;
  const statuses = new Map((statusResult.data ?? []).map(row => [row.status_key, row]));
  const sources: Record<string, string> = { own: 'Own', odcd: 'ODCD', rented: 'Van Rented', van_vendor: 'Van Vendor', vendor: 'Van Vendor' };
  const vehicles = (fleetResult.data ?? []).filter(row => !statuses.get(row.status)?.is_terminal).map(row => {
    const status = statuses.get(row.status);
    const deployed = row.deployment_status === 'deployed' && (!row.deployment_date || row.deployment_date <= today);
    return { id: row.id, number: row.vehicle_no, model: row.model || 'Model not recorded', source: sources[row.ownership_type] || row.ownership_type || 'Not recorded',
      partner: row.ownership_type === 'odcd' ? row.da_name || 'DA not recorded' : row.ownership_type === 'own' ? 'DropX' : row.vendor_name || 'Vendor not recorded',
      status: status?.label || row.status || 'Unknown', operational: deployed && Boolean(status?.is_operational), deployed, location: row.current_location_label || 'Not recorded' };
  });
  return { station, date, today, todayInbound: currentInbound,
    days, ...volumeBaseline(days, date), snapshotAt, latestInboundSnapshot: latestInbound.data?.[0]?.snapshot_at ?? null,
    bulky: days.at(-1)?.inbound != null && classified ? bulky : null,
    classified: days.at(-1)?.inbound != null ? classified : 0, packages: days.at(-1)?.inbound != null ? packages : 0, routingVerified,
    vehicles, fleetError: fleetResult.error || statusResult.error ? 'Fleet availability could not be verified.' : null,
    sizeRule: ruleResult.error ? null : ruleResult.rule,
    refreshedAt: new Date().toISOString() };
}, ['payment-volume-serving-station-v3'], { revalidate: 60 });

export function paymentVolumeToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
