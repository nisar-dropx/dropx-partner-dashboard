/** Provider identities remain strings (FHR IDs can contain leading zeroes). */
export function adhocDaIdentityFields(formData: FormData) {
  const value = (key: string) => String(formData.get(key) ?? "").trim();
  const workDate = value("adhoc_work_date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate) || !Number.isFinite(Date.parse(workDate)) || new Date(workDate).toISOString().slice(0, 10) !== workDate) {
    throw new Error("Choose the date this associate worked.");
  }
  const common = { source_system: "OPS_ADHOC_DA", adhoc_work_date: workDate, adhoc_workforce_id: null, adhoc_payout_policy: "work_day" };
  if (value("adhoc_identity_mode") === "manual_provider") {
    const id = value("adhoc_provider_employee_id");
    if (!/^[A-Za-z0-9_-]{2,40}$/.test(id)) throw new Error("Enter the provider ID. For Flipkart, use the 12-digit FHR ID.");
    const name = value("adhoc_manual_name");
    if (name.length > 160) throw new Error("Associate name must be 160 characters or fewer.");
    return { ...common, adhoc_shipment_id: null, adhoc_provider_employee_id: id, adhoc_da_name: name || id };
  }
  const shipmentId = value("adhoc_shipment_id");
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(shipmentId)) throw new Error("Select an associate or enter their provider ID.");
  return { ...common, adhoc_shipment_id: shipmentId, adhoc_provider_employee_id: null, adhoc_da_name: null };
}

export function adhocPaidDayKey(stationId: string, client: string, providerId: string, date: string) {
  return [stationId, client.trim().toLowerCase(), providerId.trim().toUpperCase(), date].join("|");
}
