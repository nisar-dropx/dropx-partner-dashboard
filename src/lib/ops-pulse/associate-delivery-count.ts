function numberValue(value: unknown) {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The associate SPR source of truth is Amazon Daily Shipment Count.
 * SWA, C-return and tracking-level Delivered Detail are reference activity only.
 */
export function officialAssociateDeliveryCount(amazonDelivery: unknown) {
  return numberValue(amazonDelivery);
}

export function officialBreakdownDeliveryCount(row: {
  base_amazon_delivery: unknown;
  smd_delivery: unknown;
  smd2_delivery: unknown;
}) {
  return numberValue(row.base_amazon_delivery) + numberValue(row.smd_delivery) + numberValue(row.smd2_delivery);
}
