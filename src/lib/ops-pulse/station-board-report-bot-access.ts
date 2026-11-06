import { hasPermission, type AuthorizationContext } from "@/lib/authorization";

export function canFlashStationBoardReportBot(auth: AuthorizationContext) {
  return auth.hasAllLocationAccess && hasPermission(auth, "ops_lm_report_bot", "edit");
}
