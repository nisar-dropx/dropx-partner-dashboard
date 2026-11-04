export type DeliveryIdentityPolicy = "none" | "legacy_adhoc_da" | "paid_associate_day" | "van_execution";
export type DeliveryPerformerMode = "standalone_odcd" | "van_driver" | "bike_da" | "existing_odcd";

export function normalizeDeliveryIdentityPolicy(value: unknown): DeliveryIdentityPolicy {
  return value === "legacy_adhoc_da" || value === "paid_associate_day" || value === "van_execution" ? value : "none";
}

function value(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

export function deliveryIdentityFields(formData: FormData, rawPolicy: unknown) {
  const policy = normalizeDeliveryIdentityPolicy(rawPolicy);
  if (policy === "none" || policy === "legacy_adhoc_da") return {};

  const workDate = value(formData, "delivery_work_date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate) || !Number.isFinite(Date.parse(workDate)) || new Date(workDate).toISOString().slice(0, 10) !== workDate) {
    throw new Error("Choose the delivery work date.");
  }
  const mode = (policy === "paid_associate_day" ? "standalone_odcd" : value(formData, "delivery_performer_mode")) as DeliveryPerformerMode;
  if (policy === "van_execution" && !["van_driver", "bike_da", "existing_odcd"].includes(mode)) {
    throw new Error("Choose who performed the van deliveries.");
  }
  if (value(formData, "delivery_identity_confirmed") !== "yes") {
    throw new Error("Confirm that the selected person used their own delivery ID.");
  }
  const shipmentId = value(formData, "delivery_shipment_id");
  const providerId = value(formData, "delivery_provider_employee_id");
  if (shipmentId && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(shipmentId)) {
    throw new Error("Select a valid delivery ID.");
  }
  if (!shipmentId && !/^[A-Za-z0-9_-]{2,40}$/.test(providerId)) {
    throw new Error("Select a delivery ID or enter the exact provider ID.");
  }
  return {
    delivery_performer_mode: mode,
    delivery_work_date: workDate,
    delivery_shipment_id: shipmentId || null,
    delivery_provider_employee_id: shipmentId ? null : providerId,
    delivery_performer_workforce_id: null,
    delivery_performer_name: null,
    delivery_identity_confirmed: true
  };
}
