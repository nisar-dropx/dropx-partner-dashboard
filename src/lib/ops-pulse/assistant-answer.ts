import { assistantSource } from "./assistant-policy.ts";
export type AssistantRead = { name: string; data?: any; error?: string };
function label(key: string) { return key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " "); }
function brief(value: any, depth = 0): string {
  if (value == null) return "not available";
  if (typeof value === "number") return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  if (depth > 2) return "details available in the source page";
  if (Array.isArray(value)) return value.slice(0, 8).map(v => brief(v, depth + 1)).join("; ") + (value.length > 8 ? `; ${value.length - 8} more` : "");
  return Object.entries(value).filter(([k]) => !["team", "rows", "companyId", "missing"].includes(k)).slice(0, 14).map(([k,v]) => `${label(k)}: ${brief(v, depth + 1)}`).join(" · ");
}
export function factualAnswer(reads: AssistantRead[]) {
  return reads.map(read => {
    const source = assistantSource(read.name).label;
    if (read.error) return `${source}: ${read.error}`;
    const data = read.data;
    if (read.name === "ops_shift_status") return `${source} · ${data.asOf} IST\n` + data.rows.map((r: any) => r.dataAvailable
      ? `${r.stationCode}: ${r.scheduled} scheduled, ${r.punched} punched, ${r.notReported} not reported, ${r.upcoming} upcoming. ${r.late} late, ${r.onLeave} on leave; ${r.noRoster + r.rosterPending} without a completed roster.`
      : `${r.stationCode}: no active people or shift records returned for this date. This does not establish that nobody is working.`).join("\n");
    if (data?.error || data?.errors?.length) return `${source}: source is incomplete or unavailable. Open the source page to check it; no clear status has been inferred.`;
    const rows = data?.rows;
    return `${source}\n${brief(data)}${rows ? "\n" + (rows.length ? rows.slice(0, 8).map((r: any) => r.latestDeliveryDate === null ? `${r.stationCode}: no delivery data in the requested period.` : brief(r)).join("\n") + (rows.length > 8 ? `\nShowing 8 of ${rows.length} returned rows. Open source for details.` : "") : "No matching records returned in this scope and period.") : ""}`;
  }).join("\n\n");
}
