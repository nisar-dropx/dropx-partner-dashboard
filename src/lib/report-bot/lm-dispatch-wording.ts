import "server-only";
import type { ReportBotSettings } from "./settings";
import type { ReportKey } from "./lm-dispatch-config";

const MAX_CAPTION = 1200;

function fallback(report: ReportKey, status: string, asOf: string, question: string, mentions: string[]) {
  const lead: Record<string, string> = {
    edd: "Why is EDD still pending for OOR? Please move the pending TIDs to OOR and confirm.",
    station: "Why are these shipments still at the station? Please assign them and complete the next action.",
    oor: "OOR report: please complete all pending pickups and share the update.",
    dsr: "Please review the DSR gap and take immediate corrective action.",
    creturn: "Please complete the pending C-Return pickups and improve pickup performance toward the 90% target.",
    ageing: "Ageing is pending. Please prioritize the oldest shipments and confirm clearance progress.",
    zero: "Some DAs have zero deliveries. Please confirm whether they are at the station or out on road and take action.",
    scrub: "Please complete both in-station and on-road scrubs and confirm the reason for any miss.",
    cod: "COD pending requires immediate station action. Please update the status and confirm.",
    recon: "DA reconciliation is pending. Please complete the cash reconciliation and confirm.",
    deposit: "Please prepare the deposit and update the portal immediately.",
    bank: "Please update the bank remittance status. If the banker has not arrived, mark Banker Not Come.",
    slip: "The deposit slip is still pending. Please upload it immediately and confirm.",
    eod: "Please review the EOD report and close all remaining operational gaps."
  };
  return [lead[report], `Status: ${status}. As of ${asOf} IST.`, question, mentions.length ? mentions.map(number => "@" + number).join(" ") : ""].filter(Boolean).join("\n");
}

/** Gemini wording is advisory; a stable operational caption is always available as a fallback. */
export async function dispatchCaption(settings: ReportBotSettings, report: ReportKey, reportName: string, status: string, asOf: string, totals: string, question: string, mentions: string[]) {
  const base = fallback(report, status, asOf, question, mentions);
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || !settings.ai_model) return base;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.ai_model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "Write concise, professional WhatsApp operations captions. Never invent facts. Preserve every supplied report name, status, IST time, total, instruction and @mention exactly. Do not mention AI. Return plain text only, maximum 600 characters." }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify({ report: reportName, status, as_of_ist: asOf, totals, instruction: question, mentions, fallback: base }) }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 400 }
      })
    });
    const payload = await response.json().catch(() => ({}));
    const text = payload?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim();
    if (!response.ok || !text || text.length > MAX_CAPTION) return base;
    return text;
  } catch {
    return base;
  } finally {
    clearTimeout(timeout);
  }
}
