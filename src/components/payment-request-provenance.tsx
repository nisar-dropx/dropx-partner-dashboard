import type { PaymentApprovalOrigin } from '@/lib/payment-requester-routing';
import type { PaymentVehicleSnapshot } from '@/lib/payment-vehicle-policy';

export function PaymentRequestProvenance({ origin, vehicle, requester, steps, compact = false }: {
  origin?: PaymentApprovalOrigin | null; vehicle?: PaymentVehicleSnapshot | null;
  requester?: string | null; steps?: number | null; compact?: boolean;
}) {
  return <>
    {origin?.skipped?.length ? <div role="note" style={{ background: '#fff1f2', color: '#9f1239', border: '1px solid #fecdd3', borderRadius: 8, padding: compact ? '4px 6px' : '10px 12px', margin: '6px 0', fontSize: compact ? 12 : 14 }}>
      <strong>Manager-raised · shortened approval chain</strong>
      {!compact ? <p style={{ margin: '4px 0 0' }}>Raised by {requester || 'the requester'} on behalf of the station. {origin.skipped.length} {origin.skipped.length === 1 ? 'stage skipped' : 'stages skipped'} to prevent self-approval. {steps ?? 1} independent approval {steps === 1 ? 'stage remains' : 'stages remain'}.</p> : null}
    </div> : null}
    {vehicle ? <div style={{ fontSize: compact ? 12 : 14, margin: '6px 0' }}><strong>{vehicle.vehicle_no}</strong> · {vehicle.model || 'Model not recorded'} · {vehicle.station_code}</div> : null}
  </>;
}
