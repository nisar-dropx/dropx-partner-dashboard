/** Validated server payload; a linked plan is completed in place, never copied. */
export function serviceWorkValues(body: Record<string, unknown>) {
  const text = (key: string) => String(body[key] ?? '').trim();
  const date = (key: string, required = false) => {
    const value = text(key);
    if (!value && !required) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw new Error('Enter a valid service date.');
    return value;
  };
  const number = (key: string) => {
    if (!text(key)) return null;
    const value = Number(body[key]);
    if (!Number.isFinite(value) || value < 0) throw new Error('Service amounts, kilometres and downtime must be zero or greater.');
    return value;
  };
  const status = text('status') || 'completed';
  if (!['completed', 'in_progress'].includes(status)) throw new Error('Choose Completed or In progress.');
  if (!text('serviceType')) throw new Error('Work category is required.');
  const serviceDate = date('serviceDate', true)!;
  const nextDate = date('nextServiceDate');
  if (nextDate && nextDate <= serviceDate) throw new Error('Next service must be after this work date.');
  const odometer = number('odometerKm'), nextOdometer = number('nextServiceOdometerKm');
  if (odometer != null && nextOdometer != null && nextOdometer <= odometer) throw new Error('Next service odometer must exceed the current reading.');
  return {service_date:serviceDate, service_type:text('serviceType'), status,
    odometer_km:odometer, next_service_date:nextDate, next_service_odometer_km:nextOdometer,
    amount:number('amount') ?? 0, downtime_hours:number('downtimeHours'),
    vendor_name:text('vendorName') || null, vendor_contact:text('vendorContact') || null,
    description:text('description') || null, invoice_url:text('invoiceUrl') || null};
}
