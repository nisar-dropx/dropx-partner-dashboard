import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import { operatingModeForLocation, resolveOperatingContext } from "@/lib/ops-pulse/operating-context";
import type { ReportWorkspace } from "@/lib/ops-pulse/report-catalog";

// Always derive workspace from the authorized locations; a URL cannot grant access.
export function resolveReportScope(locations: CodLocationRow[]) {
  const workspace: ReportWorkspace = resolveOperatingContext(locations).mode === "amazon_now" ? "ds" : "lm";
  return { workspace, locations: locations.filter((location) =>
    !location.is_ho && !location.hide_from_location_list &&
    (operatingModeForLocation(location) === "amazon_now") === (workspace === "ds")
  ) };
}

export function requestedReportCodes(requested: string[], permitted: string[]) {
  const normalized = [...new Set(requested.map((code) => code.trim().toUpperCase()).filter(Boolean))];
  if (normalized.some((code) => !permitted.includes(code))) return [];
  return normalized.length ? normalized : permitted;
}
