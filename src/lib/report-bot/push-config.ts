import { reportBotDb, type ReportBotSettings } from "./settings";
import { workerRequest } from "./worker-client";

/** Best effort: the worker also polls config every minute, so a failure here only delays it. */
export async function pushWorkerConfig(settings: ReportBotSettings) {
  if (!settings.worker_url || !settings.worker_token) return;
  try {
    const groups =
      settings.mode === "off"
        ? []
        : (
            (
              await reportBotDb()
                .from("report_bot_groups")
                .select("wa_group_id")
                .eq("company_id", settings.company_id)
                .eq("is_enabled", true)
                .throwOnError()
            ).data ?? []
          ).map((group: { wa_group_id: string }) => group.wa_group_id);
    await workerRequest(settings, "/config", {
      method: "POST",
      timeoutMs: 5000,
      body: {
        mode: settings.mode,
        groups,
        include_own_messages:
          settings.mode !== "off" && settings.include_own_messages,
      },
    });
  } catch {
    // The worker picks the change up on its next config poll.
  }
}
