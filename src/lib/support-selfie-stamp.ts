import sharp from "sharp";

export type SupportSelfieStampInput = {
  imageBuffer: Buffer;
  lat: number;
  lng: number;
  accuracyM?: number | null;
  capturedAt: string;
  stationLabel?: string | null;
};

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatCapturedAtLabel(capturedAt: string) {
  const parsed = Date.parse(capturedAt);
  const date = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  }).format(date);
}

/** Burns timestamp + GPS coordinates onto the bottom of a support selfie before storage. */
export async function stampSupportSelfieOverlay(input: SupportSelfieStampInput): Promise<Buffer> {
  const normalized = sharp(input.imageBuffer).rotate();
  const metadata = await normalized.metadata();
  const width = metadata.width ?? 720;
  const height = metadata.height ?? 1280;

  const capturedLabel = `${formatCapturedAtLabel(input.capturedAt)} IST`;
  const coordLabel = `${input.lat.toFixed(5)}, ${input.lng.toFixed(5)}${
    input.accuracyM != null && Number.isFinite(input.accuracyM) ? ` · ±${Math.round(input.accuracyM)}m` : ""
  }`;
  const stationLabel = input.stationLabel?.trim() || null;

  const barHeight = Math.max(76, Math.round(height * 0.11));
  const fontSize = Math.max(14, Math.round(width * 0.034));
  const smallFont = Math.max(12, Math.round(width * 0.028));
  const padding = Math.max(12, Math.round(width * 0.03));
  const lineGap = Math.max(6, Math.round(smallFont * 0.45));
  const secondLineY = padding + fontSize + lineGap;
  const thirdLineY = stationLabel ? secondLineY + smallFont + lineGap : secondLineY;

  const stationLine = stationLabel
    ? `<text x="${padding}" y="${thirdLineY}" fill="#e5e7eb" font-family="Arial, Helvetica, sans-serif" font-size="${smallFont}">${escapeXml(stationLabel)}</text>`
    : "";

  const svg = `
    <svg width="${width}" height="${barHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="rgba(0,0,0,0.68)"/>
      <text x="${padding}" y="${padding + fontSize}" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700">${escapeXml(capturedLabel)}</text>
      <text x="${padding}" y="${secondLineY}" fill="#f3f4f6" font-family="Arial, Helvetica, sans-serif" font-size="${smallFont}">${escapeXml(coordLabel)}</text>
      ${stationLine}
    </svg>
  `;

  return normalized
    .composite([
      {
        input: Buffer.from(svg),
        top: Math.max(0, height - barHeight),
        left: 0
      }
    ])
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}
