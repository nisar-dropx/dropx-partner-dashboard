/** Browser-side compress + timestamp/GPS stamp for OpsPulse checklist proofs. */

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.84;

export type ProofStampMeta = {
  capturedAt: string;
  latitude?: number | null;
  longitude?: number | null;
  accuracyM?: number | null;
  storeLabel?: string | null;
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
    hour12: true,
  }).format(date);
}

function loadImageFromBlob(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Unable to load photo for stamping."));
    };
    image.src = url;
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality = JPEG_QUALITY) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Unable to encode photo."))),
      "image/jpeg",
      quality,
    );
  });
}

/** Resize image to max dimension and burn IST timestamp + GPS onto the bottom bar. */
export async function compressAndStampProofImage(
  source: Blob,
  meta: ProofStampMeta,
): Promise<File> {
  let bitmap: ImageBitmap | null = null;
  let width = 0;
  let height = 0;
  try {
    bitmap = await createImageBitmap(source);
    width = bitmap.width;
    height = bitmap.height;
  } catch {
    const image = await loadImageFromBlob(source);
    width = image.naturalWidth;
    height = image.naturalHeight;
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Unable to process photo.");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    drawStampBar(ctx, canvas.width, canvas.height, meta);
    const blob = await canvasToJpeg(canvas);
    return new File([blob], proofFileName(meta.capturedAt), {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
  }

  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Unable to process photo.");
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  drawStampBar(ctx, canvas.width, canvas.height, meta);
  const blob = await canvasToJpeg(canvas);
  return new File([blob], proofFileName(meta.capturedAt), {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}

function drawStampBar(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  meta: ProofStampMeta,
) {
  const capturedLabel = `${formatCapturedAtLabel(meta.capturedAt)} IST`;
  const hasGps =
    meta.latitude != null &&
    meta.longitude != null &&
    Number.isFinite(meta.latitude) &&
    Number.isFinite(meta.longitude);
  const coordLabel = hasGps
    ? `${Number(meta.latitude).toFixed(5)}, ${Number(meta.longitude).toFixed(5)}${
        meta.accuracyM != null && Number.isFinite(meta.accuracyM)
          ? ` · ±${Math.round(meta.accuracyM)}m`
          : ""
      }`
    : "GPS unavailable";
  const storeLabel = meta.storeLabel?.trim() || null;

  const barHeight = Math.max(72, Math.round(height * 0.12));
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
  ctx.fillText(
    coordLabel,
    padding,
    barTop + padding + fontSize + lineGap + smallFont,
  );

  if (storeLabel) {
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(
      storeLabel,
      padding,
      barTop + padding + fontSize + lineGap + smallFont + lineGap + smallFont,
    );
  }
}

function proofFileName(capturedAt: string) {
  const d = new Date(Number.isFinite(Date.parse(capturedAt)) ? capturedAt : Date.now());
  const pad = (n: number) => String(n).padStart(2, "0");
  return `proof-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
}

export async function readProofGps(timeoutMs = 5000): Promise<{
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
}> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return { latitude: null, longitude: null, accuracyM: null };
  }
  try {
    const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: 60_000,
      }),
    );
    return {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracyM: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
    };
  } catch {
    return { latitude: null, longitude: null, accuracyM: null };
  }
}

/** Prepare a proof file: images get compressed + stamped; other types pass through. */
export async function prepareProofFile(
  file: File,
  meta: ProofStampMeta,
): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  try {
    return await compressAndStampProofImage(file, meta);
  } catch {
    // HEIC / undecodable formats — upload original so capture is not lost.
    return file;
  }
}
