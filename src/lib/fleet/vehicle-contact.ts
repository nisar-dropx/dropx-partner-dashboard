export const contactFields = ['da_name', 'da_contact_number', 'vendor_name', 'vendor_contact_number'] as const;
export function parseVehicleContact(body: Record<string, unknown>) {
  const values: Record<string, string | null> = {};
  for (const key of contactFields) {
    if (!(key in body)) continue;
    const value = String(body[key] ?? '').trim();
    if (!value) { values[key] = null; continue; }
    if (key.endsWith('_name')) {
      if (value.length > 160) return { error: 'Name must be 160 characters or fewer.', values: {} };
      values[key] = value;
    } else {
      const normalized = value.replace(/[\s()-]/g, '');
      if (!/^\+?\d{7,15}$/.test(normalized)) return { error: 'Enter a valid contact number with 7–15 digits, optionally starting with +.', values: {} };
      values[key] = normalized;
    }
  }
  return { error: null, values };
}
