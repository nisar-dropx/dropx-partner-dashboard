import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { loadShipmentSizeRule } from '@/lib/ops-pulse/capacity';
import { shipmentSize } from '@/lib/payment-volume';
import { dimensionalWeight, positiveMeasurement, shipmentDestinationAllowed, type ShipmentEvidence } from '@/lib/payment-shipment-evidence';

// The caller must authorize the payment request before calling this loader.
export async function loadPaymentShipmentEvidence(company: string, station: string, trackingIds: string[]) {
  if (!supabaseAdmin) throw new Error('Shipment data unavailable');
  const db = supabaseAdmin;
  const stations = await db.from('stations').select('id,station_code,parent_station_id,is_active,inbound_requires_destination,location_models(code)').eq('company_id', company);
  if (stations.error) throw new Error('Station scope unavailable');
  const parent = stations.data.find(row => row.station_code === station);
  const scope = [station, ...stations.data.filter(row => parent && row.is_active && row.parent_station_id === parent.id && (Array.isArray(row.location_models) ? row.location_models[0] : row.location_models)?.code === 'XPT').map(row => row.station_code)];
  const ids = [...new Set(trackingIds)].slice(0, 500);
  const chunks = Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => ids.slice(index * 100, index * 100 + 100));
  const [rule, results] = await Promise.all([
    loadShipmentSizeRule(company),
    Promise.all(chunks.map(chunk => db.from('inbound_shipment_facts')
      .select('tracking_id,postal_code,actual_weight_kg,length_cm,width_cm,height_cm,cubic_volume_cm3,snapshot_at,serving_station_code:raw_payload->>serving_station_code')
      .eq('company_id', company).in('station_code', scope).in('tracking_id', chunk)))
  ]);
  if (results.some(result => result.error)) throw new Error('Shipment evidence unavailable');
  const facts = new Map(results.flatMap(result => result.data ?? []).filter(row => shipmentDestinationAllowed(row.serving_station_code, scope, Boolean(parent?.inbound_requires_destination))).map(row => [row.tracking_id, row]));
  const sizeRule = rule.error ? null : rule.rule;
  const rows: ShipmentEvidence[] = ids.map(trackingId => {
    const fact = facts.get(trackingId);
    return { trackingId, matched: Boolean(fact), pincode: fact?.postal_code && /^[1-9]\d{5}$/.test(fact.postal_code.trim()) ? fact.postal_code.trim() : null,
      weightKg: positiveMeasurement(fact?.actual_weight_kg), lengthCm: positiveMeasurement(fact?.length_cm), widthCm: positiveMeasurement(fact?.width_cm), heightCm: positiveMeasurement(fact?.height_cm),
      volumetricKg: dimensionalWeight(fact?.length_cm, fact?.width_cm, fact?.height_cm, fact?.cubic_volume_cm3, sizeRule?.dimensionalDivisor),
      suitability: fact ? shipmentSize(fact, sizeRule) : 'unknown', snapshotAt: fact?.snapshot_at ?? null };
  });
  return { rows, total: trackingIds.length, divisor: sizeRule?.dimensionalDivisor ?? null };
}
