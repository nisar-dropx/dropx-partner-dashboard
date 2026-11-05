import "server-only";
import { randomBytes } from "crypto";
import { isTestingGroupName } from "@/lib/report-bot/logic";
import { loadReportBotSettings, reportBotDb, type ReportBotSettings } from "@/lib/report-bot/settings";
import { WorkerError, workerRequest } from "@/lib/report-bot/worker-client";

export { canFlashStationBoardReportBot } from "./station-board-report-bot-access";

function newClientRef(prefix: string) {
  return `${prefix}_${randomBytes(12).toString("base64url")}`.slice(0, 64);
}

function fallbackCaption(input: { title: string; subtitle: string; view: string; businessDate: string; page?: number; pages?: number }) {
  const page = input.pages && input.pages > 1 && input.page ? ` · ${input.page}/${input.pages}` : "";
  return [`📊 ${input.title}${page}`, input.subtitle, `Live performance · ${input.view.toUpperCase()} · ${input.businessDate}`, "Sent via DropX Report Bot (Testing)"].filter(Boolean).join("\n").slice(0, 1024);
}

/** Short WhatsApp caption for a station-board flash. Gemini when available; never blocks the send. */
export async function composeBoardFlashCaption(
  settings: ReportBotSettings,
  input: {
    title: string;
    subtitle: string;
    view: string;
    businessDate: string;
    stationCount?: number;
    image?: Uint8Array | null;
    mime?: "image/jpeg" | "image/png" | "image/webp" | null;
  },
): Promise<string> {
  const fallback = fallbackCaption(input);
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return fallback;

  const model = settings.ai_provider === "gemini" && settings.ai_model
    ? settings.ai_model
    : "gemini-2.5-flash";
  const parts: Array<Record<string, unknown>> = [];
  if (input.image?.length && input.mime) {
    parts.push({ inlineData: { mimeType: input.mime, data: Buffer.from(input.image).toString("base64") } });
  }
  parts.push({
    text: [
      "Write a short WhatsApp caption for a Last Mile live-performance station board report image.",
      "2 to 4 short lines. Plain language for ops leads. No markdown, no hashtags, no emojis except at most one at the start.",
      "Mention the report focus, date, and one useful observation if the image is readable; otherwise stay general.",
      "Do not invent exact percentages or counts you cannot see.",
      `Title: ${input.title}`,
      `Subtitle: ${input.subtitle}`,
      `View: ${input.view}`,
      `Business date: ${input.businessDate}`,
      `Stations in scope: ${input.stationCount ?? "unknown"}`,
      "Reply with only the caption text."
    ].join("\n")
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { maxOutputTokens: 280, temperature: 0.4 }
        })
      }
    );
    const payload = await response.json().catch(() => ({})) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
    };
    if (!response.ok) return fallback;
    const text = (payload.candidates?.[0]?.content?.parts ?? [])
      .filter((part) => typeof part.text === "string" && !part.thought)
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) return fallback;
    return text.slice(0, 1024);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

export type TestingFlashGroup = {
  id: string;
  wa_group_id: string;
  group_name: string | null;
  workspace: string;
};

export async function loadTestingFlashGroup(companyId: string): Promise<TestingFlashGroup> {
  const result = await reportBotDb()
    .from("report_bot_groups")
    .select("id,wa_group_id,group_name,workspace,is_enabled")
    .eq("company_id", companyId)
    .eq("is_enabled", true);
  if (result.error) throw new Error(result.error.message);
  const testing = (result.data ?? []).find((group) => isTestingGroupName(group.group_name));
  if (!testing?.wa_group_id) {
    throw new Error('Enable the WhatsApp group named exactly "Testing" in Report Bot, then try again.');
  }
  return {
    id: testing.id,
    wa_group_id: testing.wa_group_id,
    group_name: testing.group_name,
    workspace: testing.workspace
  };
}

export type BoardFlashImage = {
  bytes: Uint8Array;
  mime: "image/jpeg" | "image/png" | "image/webp";
};

/**
 * Flash station-board report image(s) to the Testing group via the Report Bot worker.
 * Caption is generated once (Gemini) and attached to the first image only.
 */
export async function flashStationBoardToTestingGroup(input: {
  companyId: string;
  title: string;
  subtitle: string;
  view: string;
  businessDate: string;
  stationCount?: number;
  images: BoardFlashImage[];
  page?: number;
  pages?: number;
  skipAiCaption?: boolean;
}): Promise<{ sent: number; groupName: string; caption: string }> {
  if (!input.images.length) throw new Error("Nothing to flash.");
  if (input.images.length > 12) throw new Error("Too many image pages to flash at once (max 12).");

  const settings = await loadReportBotSettings(input.companyId);
  if (settings.mode !== "live") {
    throw new Error("Report Bot must be in Live mode before flashing to WhatsApp.");
  }
  if (!settings.worker_url || !settings.worker_token) {
    throw new Error("Report Bot worker is not connected. Open Report Bot setup first.");
  }

  const group = await loadTestingFlashGroup(input.companyId);
  const page = input.page ?? 1;
  const pages = input.pages ?? input.images.length;
  const first = input.images[0];
  const caption = input.skipAiCaption
    ? fallbackCaption({
      title: input.title,
      subtitle: input.subtitle,
      view: input.view,
      businessDate: input.businessDate,
      page,
      pages
    })
    : await composeBoardFlashCaption(settings, {
      title: input.title,
      subtitle: input.subtitle,
      view: input.view,
      businessDate: input.businessDate,
      stationCount: input.stationCount,
      image: first.bytes,
      mime: first.mime
    });

  let sent = 0;
  for (let index = 0; index < input.images.length; index += 1) {
    const image = input.images[index];
    if (!image.bytes.length) continue;
    if (image.bytes.length > 8 * 1024 * 1024) {
      throw new Error(`Image page ${index + 1} is too large to send (max 8 MB).`);
    }
    const pageCaption = index === 0
      ? caption
      : fallbackCaption({
        title: input.title,
        subtitle: input.subtitle,
        view: input.view,
        businessDate: input.businessDate,
        page: page + index,
        pages
      });
    try {
      await workerRequest<{ id: string | null }>(settings, "/send", {
        method: "POST",
        timeoutMs: 90_000,
        body: {
          client_ref: newClientRef(`sb${page}_${index}`),
          to: group.wa_group_id,
          image_base64: Buffer.from(image.bytes).toString("base64"),
          mime: image.mime,
          caption: pageCaption
        }
      });
      sent += 1;
    } catch (error) {
      if (error instanceof WorkerError) throw new Error(error.message);
      throw error;
    }
    if (index < input.images.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }

  if (!sent) throw new Error("No images were sent.");
  return { sent, groupName: group.group_name || "Testing", caption };
}
