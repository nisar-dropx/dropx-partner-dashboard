type Item = { status: string };
type Run = { status: string; payment_date?: string | null; paid_at?: string | null; payment_reference?: string | null };
type Payment = { status: string; processed_at?: string | null; utr_cin?: string | null };

/** Individual reconciliation wins over the batch status, including partial batches. */
export function workforcePaymentStatus(item: Item, run: Run, payment?: Payment | null) {
  if (!['ready', 'paid'].includes(item.status) || !['approved', 'paid'].includes(run.status)) return null;
  if (payment) {
    const paid = payment.status === 'processed' && item.status === 'paid';
    const labels: Record<string, string> = {pending:'Finance approval pending', approved:'Approved for payment', processing:'Bank processing', returned:'Returned for review', rejected:'Payment rejected', cancelled:'Payment cancelled'};
    return {status:paid ? 'paid' : payment.status === 'processed' ? 'reconciling' : payment.status,
      statusLabel:paid ? 'Paid' : payment.status === 'processed' ? 'Reconciliation pending' : labels[payment.status] ?? 'Finance review',
      paymentDate:paid ? payment.processed_at ?? null : null,
      paymentReference:paid ? payment.utr_cin ?? null : null};
  }
  const paid = item.status === 'paid' && run.status === 'paid';
  return {status:paid ? 'paid' : 'approved',statusLabel:paid ? 'Paid' : 'Awaiting Finance handoff',
    paymentDate:paid ? run.payment_date ?? run.paid_at ?? null : null,
    paymentReference:paid ? run.payment_reference ?? null : null};
}

export function workforceStatementDate(input: string | null) {
  if (!input) return '—';
  const value = new Date(/^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T00:00:00+05:30` : input);
  return Number.isNaN(value.getTime()) ? '—' : new Intl.DateTimeFormat('en-IN', {day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Kolkata'}).format(value);
}
