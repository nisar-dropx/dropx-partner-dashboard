import type { AuthorizationContext } from "@/lib/authorization";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
export { indiaDate, parseIsoDate, parseStationCodes } from "@/lib/mcp/dates";

export async function resolveScopedLocations(
  authorization: AuthorizationContext,
  requestedCodes: string[] = []
): Promise<{ locations: CodLocationRow[]; missing: string[]; companyId: string }> {
  const companyId = authorization.companyId;
  if (!companyId) throw new Error("Company scope missing.");
  const locationResult = await loadCodLocations(
    companyId,
    authorization.locationScopeIds,
    authorization.hasAllLocationAccess
  );
  const permitted = locationResult.locations;
  if (!requestedCodes.length) {
    return { locations: permitted, missing: [], companyId };
  }
  const byCode = new Map(permitted.map((row) => [row.station_code.toUpperCase(), row]));
  const locations: CodLocationRow[] = [];
  const missing: string[] = [];
  for (const code of requestedCodes) {
    const row = byCode.get(code.toUpperCase());
    if (row) locations.push(row);
    else missing.push(code);
  }
  return { locations, missing, companyId };
}
