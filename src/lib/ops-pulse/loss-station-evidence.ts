export type StationEvidence = {
  reason: string;
  note: string;
  tt_reference: string;
  evidence_url: string;
  cctv_url?: string;
  cctv_not_required?: boolean;
};

/** Shared by the station form and the authenticated write API. */
export function stationEvidenceError(details: StationEvidence): string | null {
  for (const [value, label, min, max] of [
    [details.reason, "Redispute reason", 5, 300],
    [details.tt_reference, "Cloak ticket ID", 3, 160],
    [details.note, "Detailed description", 10, 4000],
  ] as const) {
    const length = value.trim().length;
    if (length < min || length > max) return `${label} is required (${min}–${max} characters).`;
  }
  const links = [[details.evidence_url, "Supporting photos / files link"]];
  if (details.cctv_not_required !== true) links.push([details.cctv_url || "", "CCTV footage link"]);
  for (const [value, label] of links) {
    try {
      const url = new URL(value.trim());
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || value.length > 2000) throw Error();
    } catch {
      return `${label} is required. Use a valid HTTPS file or folder link.`;
    }
  }
  return null;
}
