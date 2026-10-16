import "server-only";
import { getAuthorization, hasPermission, type AuthorizationContext } from "@/lib/authorization";

export const REPORT_BOT_PAGE = "ops_report_bot";

/** Station-scoped users only see groups linked to their stations; unlinked groups need all-location access. */
export function canSeeGroup(authorization: AuthorizationContext, group: { location_id: string | null }) {
  if (authorization.hasAllLocationAccess) return true;
  return Boolean(group.location_id && authorization.locationScopeIds.includes(group.location_id));
}

/** For route handlers: returns null instead of redirecting. */
export async function reportBotApiAuthorization(action: "access" | "edit") {
  const authorization = await getAuthorization();
  if (!authorization?.companyId || !hasPermission(authorization, REPORT_BOT_PAGE, action)) return null;
  return authorization;
}
