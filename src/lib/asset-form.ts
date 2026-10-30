import { conditionForAssetQuantity, resolveAssetQuantities } from './asset-quantity';

export const emptyAssetForm = {
  category_name: '', type_name: '', location_id: '', tracking_mode: 'individual', quantity_total: '1', quantity_faulty: '0',
  ownership_type: 'owned', condition: 'good', manufacturer: '', model: '', serial_number: '', invoice_number: '',
  purchase_order_number: '', purchase_date: '', purchase_value: '', gst_rate: '', gst_amount: '', total_value: '',
  warranty_expiry_date: '', vendor_name: '', notes: '', rental_vendor_name: '', rental_agreement_number: '', rental_invoice_number: '',
  rental_rate: '', rental_billing_frequency: 'monthly', rental_security_deposit: '0', rental_starts_on: '',
  rental_ends_on: '', rental_notice_period_days: '0', change_reason: '',
};
export function assetFormValues(asset: Record<string, any>): typeof emptyAssetForm {
  const form = { ...emptyAssetForm };
  for (const key of Object.keys(form) as Array<keyof typeof form>) {
    if (asset[key] != null) form[key] = String(asset[key]);
  }
  const term = asset.rental_term;
  if (term) for (const key of ['vendor_name', 'agreement_number', 'invoice_number', 'rental_rate', 'billing_frequency', 'security_deposit', 'starts_on', 'ends_on', 'notice_period_days']) {
    const formKey = (key === 'rental_rate' ? key : `rental_${key}`) as keyof typeof form;
    if (term[key] != null) form[formKey] = String(term[key]);
  }
  return form;
}
const clean = (v: unknown, max = 160) => String(v ?? '').trim().slice(0, max);
function date(v: unknown, label: string, required = false) {
  const value = clean(v);
  if (!value && !required) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw Error(`${label} must be a valid date.`);
  return value;
}
function amount(v: unknown, label: string, required = false) {
  const value = clean(v);
  if (!value && !required) return null;
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(value)) throw Error(`${label} must be a non-negative amount with up to two decimal places.`);
  return Number(value);
}
export function parseAssetEdit(item: Record<string, unknown>) {
  const category = clean(item.category_name, 100), type = clean(item.type_name, 100);
  if (!category || !type) throw Error('Category and asset type are required.');
  const ownership = clean(item.ownership_type), mode = clean(item.tracking_mode), requestedCondition = clean(item.condition);
  if (!['owned', 'rented', 'leased'].includes(ownership)) throw Error('Choose owned, rented or leased.');
  if (!['individual', 'quantity'].includes(mode)) throw Error('Choose a valid record method.');
  if (!['good', 'fair', 'damaged', 'unusable'].includes(requestedCondition)) throw Error('Choose a valid condition.');
  const q = resolveAssetQuantities({ trackingMode: mode, total: item.quantity_total, faulty: item.quantity_faulty, individualCondition: requestedCondition });
  const asset: Record<string, any> = {
    location_id: clean(item.location_id, 36) || null, ownership_type: ownership, tracking_mode: q.trackingMode,
    quantity_total: q.total, quantity_working: q.working, quantity_faulty: q.faulty,
    condition: mode === 'quantity' ? conditionForAssetQuantity(q.total, q.faulty) : requestedCondition,
    purchase_date: date(item.purchase_date, 'Purchase date'), warranty_expiry_date: date(item.warranty_expiry_date, 'Warranty expiry'),
    purchase_value: amount(item.purchase_value, 'Base value'), gst_rate: amount(item.gst_rate, 'GST rate'),
    gst_amount: amount(item.gst_amount, 'GST amount'), total_value: amount(item.total_value, 'Landed value'), notes: clean(item.notes, 1000) || null,
  };
  if (asset.gst_rate > 100) throw Error('GST rate cannot exceed 100%.');
  for (const key of ['manufacturer', 'model', 'serial_number', 'invoice_number', 'purchase_order_number', 'vendor_name']) asset[key] = clean(item[key]) || null;
  let rental: Record<string, any> | null = null;
  if (ownership !== 'owned') {
    const vendor = clean(item.rental_vendor_name), frequency = clean(item.rental_billing_frequency);
    if (!vendor) throw Error('Rental vendor is required.');
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(frequency)) throw Error('Choose a valid rental billing frequency.');
    const days = clean(item.rental_notice_period_days) || '0';
    if (!/^\d+$/.test(days) || Number(days) > 3650) throw Error('Notice days must be a whole number between 0 and 3650.');
    rental = { vendor_name: vendor, agreement_number: clean(item.rental_agreement_number) || null, invoice_number: clean(item.rental_invoice_number) || null,
      rental_rate: amount(item.rental_rate, 'Rental rate', true), billing_frequency: frequency, security_deposit: amount(item.rental_security_deposit, 'Security deposit') ?? 0,
      starts_on: date(item.rental_starts_on, 'Rental start', true), ends_on: date(item.rental_ends_on, 'Rental end'), notice_period_days: Number(days) };
    if (rental.ends_on && rental.ends_on < rental.starts_on) throw Error('Rental end cannot precede its start.');
  }
  return { category, type, asset, rental, reason: clean(item.change_reason, 500) };
}
