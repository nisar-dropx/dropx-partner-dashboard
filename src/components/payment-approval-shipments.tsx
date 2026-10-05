"use client";
import { useEffect, useRef, useState } from 'react';
import { optionalPaymentEvidence } from '@/lib/optional-payment-evidence';
import { PaymentShipmentEvidence } from '@/components/payment-shipment-evidence';
import type { ShipmentEvidence } from '@/lib/payment-shipment-evidence';
import styles from './payment-shipment-evidence.module.css';

type Evidence = { rows: ShipmentEvidence[]; total: number; divisor: number | null };
export function PaymentApprovalShipments({ requestId, count }: {requestId: string; count: number}) {
  const [data, setData] = useState<Evidence | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const load = async () => {
    if (controller.current || data) return;
    const abort = new AbortController(); controller.current = abort;
    setStatus('loading');
    const result = await optionalPaymentEvidence(async () => {
      const response = await fetch(`/api/payments/shipment-evidence?request=${encodeURIComponent(requestId)}`, {signal: abort.signal, cache: 'no-store'});
      if (!response.ok) throw new Error('Evidence unavailable');
      const value = await response.json();
      if (!value || !Array.isArray(value.rows) || !Number.isFinite(value.total)) throw new Error('Invalid evidence');
      return value as Evidence;
    });
    if (abort.signal.aborted) return;
    abort.abort(); controller.current = null;
    setData(result.data); setStatus(result.data ? 'ready' : 'error');
  };
  return <details className={styles.panel} onToggle={event => { if (event.currentTarget.open && status === 'idle') void load(); }}>
    <summary>Shipments · {count} IDs <span>Weight · size · pincode</span></summary>
    {status === 'loading' ? <p className={styles.body} role="status">Loading optional details… You can continue reviewing.</p> : null}
    {status === 'error' ? <div className={styles.body} role="status">Details unavailable. Review actions remain available. <button type="button" onClick={() => void load()}>Retry</button></div> : null}
    {data ? <PaymentShipmentEvidence {...data} /> : null}
  </details>;
}
