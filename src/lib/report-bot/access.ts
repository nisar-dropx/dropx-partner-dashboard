import "server-only";
import { getAuthorization, hasPermission, type AuthorizationContext } from "@/lib/authorization";

import { reportBotPage, type ReportBotWorkspace } from "./workspace";

export type ReportBotAuthorization = AuthorizationContext & { reportBotWorkspace?: ReportBotWorkspace };

export const REPORT_BOT_PAGE = "ops_report_bot";

/** Station-scoped users only see groups linked to their stations; unlinked groups need all-location access. */
export function canSeeGroup(authorization: ReportBotAuthorization, group: { location_id: string | null; workspace?: ReportBotWorkspace }) {
  const workspace = group.workspace ?? "dark_store";
  if (authorization.reportBotWorkspace && authorization.reportBotWorkspace !== workspace) return false;
  if (!hasPermission(authorization, reportBotPage(workspace), "access")) return false;
  if (authorization.hasAllLocationAccess) return true;
  return Boolean(group.location_id && authorization.locationScopeIds.includes(group.location_id));
}

/** For route handlers: returns null instead of redirecting. */
export async function reportBotApiAuthorization(action: "access" | "edit", workspace: ReportBotWorkspace | "any" = "dark_store") {
  const authorization = await getAuthorization();
  if (!authorization?.companyId || !(workspace === "any" ? ["dark_store", "last_mile"].some((w) => hasPermission(authorization, reportBotPage(w as ReportBotWorkspace), action)) : hasPermission(authorization, reportBotPage(workspace), action))) return null;
  return authorization;
}
