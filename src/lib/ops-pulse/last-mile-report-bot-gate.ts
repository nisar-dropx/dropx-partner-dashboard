import "server-only";
import { redirect } from "next/navigation";
import type { ReportBotWorkspace } from "@/lib/report-bot/workspace";
import { canAccessLastMileReportBot } from "@/lib/ops-pulse/last-mile-report-bot-access";

/** Last Mile Report Bot is Joseph-only while it is still in preview. */
export function requireLastMileReportBotAccess(
  workspace: ReportBotWorkspace,
  email: string | null | undefined,
) {
  if (workspace === "last_mile" && !canAccessLastMileReportBot(email)) {
    redirect("/unauthorized?page=ops_lm_report_bot&reason=access");
  }
}
