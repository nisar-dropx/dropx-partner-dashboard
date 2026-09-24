import { supabaseAdmin } from '@/lib/supabase-admin';
import type { WheelseyeMovementSummary } from '@/lib/wheelseye-history';

/** Shared by on-demand refresh and fuel import so corrected values and quality flags cannot diverge. */
export async function saveDailyWheelseyeKm(companyId: string, vehicle: string, date: string, summary: WheelseyeMovementSummary) {
  if (summary.pointCount < 2) return 'no_data';
  if (!supabaseAdmin) return 'save_failed';
  const existing = await supabaseAdmin.from('fleet_daily_km').select('id,calculated_at').eq('company_id', companyId).eq('vehicle_no', vehicle).eq('movement_date', date).eq('source', 'wheelseye').maybeSingle();
  if (existing.error) return 'save_failed';
  const values = {
    km: summary.km, raw_km: summary.rawKm, point_count: summary.pointCount,
    accepted_point_count: summary.acceptedPointCount, rejected_point_count: summary.rejectedPointCount,
    stationary_point_count: summary.stationaryPointCount, algorithm_version: summary.algorithmVersion,
    review_status: !summary.distanceReliable ? 'needs_review' : summary.quality === 'filtered' ? 'auto_corrected' : 'auto_approved',
    calculated_at: new Date().toISOString()
  };
  // The legacy unique key omits company_id. Never upsert across that key.
  const saved = existing.data
    ? await supabaseAdmin.from('fleet_daily_km').update(values).eq('company_id', companyId).eq('id', existing.data.id).eq('calculated_at', existing.data.calculated_at).select('id')
    : await supabaseAdmin.from('fleet_daily_km').insert({ ...values, company_id: companyId, vehicle_no: vehicle, movement_date: date, source: 'wheelseye' }).select('id');
  return saved.error || !saved.data?.length ? 'save_failed' : summary.distanceReliable ? 'updated' : 'needs_review';
}
