export type SupportSelfieStampInput = {
  lat: number;
  lng: number;
  accuracyM?: number | null;
  capturedAt: string;
  stationLabel?: string | null;
};

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

function loadImage(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Unable to load selfie for stamping."));
    };
    image.src = url;
  });
}

/** Burns timestamp + GPS onto the bottom of a support selfie using canvas (browser fonts). */
export async function stampSupportSelfieBlob(blob: Blob, input: SupportSelfieStampInput): Promise<Blob> {
  const image = await loadImage(blob);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Unable to stamp selfie.");

  ctx.drawImage(image, 0, 0, width, height);

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
  const barTop = height - barHeight;

  ctx.fillStyle = "rgba(0,0,0,0.68)";
  ctx.fillRect(0, barTop, width, barHeight);

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${fontSize}px Arial, Helvetica, sans-serif`;
  ctx.fillText(capturedLabel, padding, barTop + padding + fontSize);

  ctx.fillStyle = "#f3f4f6";
  ctx.font = `${smallFont}px Arial, Helvetica, sans-serif`;
  ctx.fillText(coordLabel, padding, barTop + padding + fontSize + lineGap + smallFont);

  if (stationLabel) {
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(stationLabel, padding, barTop + padding + fontSize + lineGap + smallFont + lineGap + smallFont);
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (stamped) => (stamped ? resolve(stamped) : reject(new Error("Unable to stamp selfie."))),
      "image/jpeg",
      0.88
    );
  });
}
