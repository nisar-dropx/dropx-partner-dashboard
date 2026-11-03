export type ReportBotWorkspace = "dark_store" | "last_mile";

export function reportBotWorkspace(value: unknown): ReportBotWorkspace {
  if (value === undefined || value === null || value === "" || value === "dark_store") return "dark_store";
  if (value === "last_mile") return "last_mile";
  throw new Error("Invalid report workspace.");
}

export function reportBotPage(workspace: ReportBotWorkspace) {
  return workspace === "last_mile" ? "ops_lm_report_bot" : "ops_report_bot";
}

export function reportBotHref(workspace: ReportBotWorkspace, tab = "today") {
  return `/report-bot?workspace=${workspace}&tab=${tab}`;
}

export function reportBotChatHref(workspace: ReportBotWorkspace, group?: string) {
  return `/report-bot/chats?workspace=${workspace}${group ? `&group=${encodeURIComponent(group)}` : ""}`;
}

export function reportBotSetupHref(workspace: ReportBotWorkspace) {
  return `/report-bot/setup?workspace=${workspace}`;
}
