/** DropX dark-store station allowlist + war-room JIDs (same as site-summary). */
export const ALLOWED_STATIONS = new Set([
  "TCC3", "TCD4", "TTB3", "TTA5", "TZC4", "TTG9", "TFB7"
]);

export const STATION_JIDS = {
  TTB3: "120363424079156767@g.us",
  TTG9: "120363427914569852@g.us",
  TCC3: "120363424408130632@g.us",
  TCD4: "120363407865525845@g.us",
  TTA5: "120363425009535873@g.us",
  TZC4: "120363411844052790@g.us",
  TFB7: "120363432925308998@g.us"
};

const STATION_PREFIX = /\b(TCC3|TCD4|TTB3|TTA5|TZC4|TTG9|TFB7)\b/i;

export function extractStationCode(...sources) {
  for (const raw of sources) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    const m = text.match(STATION_PREFIX);
    if (m) return m[1].toUpperCase();
    const lead = text.match(/^(TCC3|TCD4|TTB3|TTA5|TZC4|TTG9|TFB7)\b/i);
    if (lead) return lead[1].toUpperCase();
  }
  return null;
}