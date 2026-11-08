/** Only request context, never arbitrary JSON or beneficiary banking data. */
export type PaymentRequestFact = { label: string; value: string };
export function paymentRequestFacts(row: Record<string, unknown>): PaymentRequestFact[] {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const details = object(row.details);
  const driver = object(details.adhoc_driver);
  const vehicle = object(details.payment_vehicle);
  const fuel = object(details.van_fuel);
  const replacement = object(row.adhoc_vehicle_snapshot);
  const facts: PaymentRequestFact[] = [];
  const add = (label: string, value: unknown) => {
    if (typeof value === 'string' && value.trim()) facts.push({ label, value: value.trim() });
  };
  add('Requested for', row.requested_for_name);
  const modes: Record<string, string> = { van_driver: 'Van driver', bike_da: 'Existing bike DA', existing_odcd: 'Existing ODCD DA', standalone_odcd: 'ODCD delivery associate' };
  const mode = typeof row.delivery_performer_mode === 'string' ? modes[row.delivery_performer_mode] : undefined;
  add('Who is doing delivery?', mode);
  add('Delivery associate', row.delivery_performer_name || row.adhoc_da_name);
  add('Provider / employee ID', row.delivery_provider_employee_id || row.adhoc_provider_employee_id);
  if (row.delivery_identity_confirmed === true) add('Delivery ID confirmation', 'Own delivery ID confirmed');
  add('Work date', driver.work_date || row.delivery_work_date || row.adhoc_work_date || row.work_date || row.adhoc_deployment_date);
  add('Reason', driver.reason_label || replacement.reason);
  add('Person on leave', driver.person_name);
  add('DropX ID', driver.dropx_id);
  add('Vehicle number', vehicle.vehicle_no || fuel.vehicle_no || driver.vehicle_no || replacement.number);
  add('Vehicle status', replacement.status);
  add('Fuel date', fuel.fuel_date);
  add('Request remarks', row.remarks);
  return facts;
}

export function paymentTrackingSearch(value: string) {
  const query = value.trim();
  if (!query || query.length > 120) return null;
  return { query, column: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query) ? 'id' : 'request_no' };
}
