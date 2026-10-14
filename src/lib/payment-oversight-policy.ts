/** Visibility never grants approval authority. Location scope remains authoritative. */
export function canOverseePayment(
  authorization: { hasAllLocationAccess: boolean; locationScopeIds: string[]; permissions: Record<string, { canView: boolean }> },
  request: { location_id: string | null }
) {
  return Boolean(authorization.permissions.payment_oversight?.canView) &&
    (authorization.hasAllLocationAccess || Boolean(request.location_id && authorization.locationScopeIds.includes(request.location_id)));
}

export function paymentPendingAge(since: string | null, now = new Date()) {
  if (!since || !Number.isFinite(Date.parse(since))) return "Time unavailable";
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / 60000));
  if (minutes < 60) return `${minutes}m pending`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m pending`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h pending`;
}
