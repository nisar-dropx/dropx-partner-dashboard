export function isLongPaymentDetail(value: string) {
  return value.length > 180 || value.split('\n').length > 3;
}

/** Keep the full submitted value accessible without letting lists bury the timeline. */
export function PaymentDetailValue({ value, label }: { value: string; label: string }) {
  if (!isLongPaymentDetail(value)) return <>{value}</>;
  const isShipments = /tracking.*ids?|shipment.*ids?/i.test(label);
  const count = value.split(/[\s,;]+/).filter(Boolean).length;
  return <details className="payment-detail-expand">
    <summary>{isShipments ? `${count} Shipment IDs · View all` : `${value.slice(0, 110).trimEnd()}… Read more`}</summary>
    <div className="payment-detail-full" tabIndex={0} aria-label={label}>{value}</div>
  </details>;
}
