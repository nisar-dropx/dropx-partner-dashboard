import { createHash } from 'node:crypto';
export const assetEditFields = ['asset_type_id', 'location_id', 'manufacturer', 'model', 'serial_number', 'purchase_order_number', 'invoice_number', 'purchase_date', 'purchase_value', 'gst_rate', 'gst_amount', 'total_value', 'warranty_expiry_date', 'vendor_name', 'ownership_type', 'status', 'condition', 'tracking_mode', 'quantity_total', 'quantity_working', 'quantity_faulty', 'notes', 'is_active'] as const;
export const rentalEditFields = ['vendor_name', 'agreement_number', 'invoice_number', 'rental_rate', 'billing_frequency', 'security_deposit', 'starts_on', 'ends_on', 'notice_period_days', 'off_hire_date', 'status'] as const;
export function assetVersion(asset: Record<string, any>, rental: Record<string, any> | null) {
  return createHash('sha256').update(JSON.stringify([asset.id, assetEditFields.map(k => asset[k] ?? null), rental ? [rental.id, ...rentalEditFields.map(k => rental[k] ?? null)] : null])).digest('hex');
}
