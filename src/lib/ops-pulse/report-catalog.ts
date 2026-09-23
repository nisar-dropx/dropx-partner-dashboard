export const opsReportCatalog = [
  { type: "adhoc_da", group: "Payments", title: "Adhoc DA / Wishmaster payments", description: "Work-date range: station, DA/provider ID, delivered count, requested/paid amounts and one-time payroll recovery. Includes payment-level audit details.", format: "Excel" },
  { type: "shipment_station", group: "Shipments", title: "Station shipment summary", description: "Day-level delivered volume, road IDs, SPR and small/volumetric mix.", format: "CSV" },
  { type: "shipment_pincode", group: "Shipments", title: "Pincode volume & size mix", description: "Station and pincode volume with small, volumetric and unclassified percentages.", format: "CSV" },
  { type: "shipment_promise", group: "Shipments", title: "Customer promise", description: "Station and pincode promise-date performance with early, on-promise and late volume.", format: "CSV" },
  { type: "inbound_daily", group: "Shipments", title: "Inbound volume", description: "Expected-arrival day volume by station and pincode.", format: "CSV" },
  { type: "station_360", group: "Shipments", title: "Station 360 workbook", description: "One station workbook with daily summary, pincode mix, inbound and customer promise.", format: "Excel", singleStation: true },
  { type: "station_delivery", group: "Operations", title: "Station delivery", description: "Assigned, delivered, returns, MFN, active DAs and productivity.", format: "CSV" },
  { type: "da_delivery", group: "Operations", title: "DA delivery detail", description: "Associate-level assigned, delivered, SWA, returns, MFN and activity.", format: "CSV" },
  { type: "capacity", group: "Operations", title: "Capacity & productivity", description: "Present capacity, active delivery capacity, shipment volume and SPR.", format: "CSV" },
  { type: "closure", group: "Operations", title: "Daily operations closure", description: "Station closure submissions and manager review status.", format: "CSV" },
  { type: "attendance", group: "People", title: "DA attendance", description: "Day-level punches, in/out time and work duration.", format: "CSV" },
  { type: "cps", group: "Finance", title: "Station CPS & cost", description: "Station-day costs, CPS components, target and impact.", format: "CSV" },
  { type: "cod", group: "Finance", title: "COD submission status", description: "Deposit, validation, variance and remittance status.", format: "CSV" }
] as const;

export type OpsReportType = typeof opsReportCatalog[number]["type"];
export function isOpsReportType(value: string): value is OpsReportType {
  return opsReportCatalog.some((report) => report.type === value);
}
