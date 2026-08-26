type FaceMatchResult = {
  ok: boolean;
  /** Cosine similarity 0–1 (clamped). */
  score: number;
  /** Display percent 0–100. */
  percent: number;
  reason?: string;
};

type FaceBox = { x: number; y: number; width: number; height: number };

const FACE_SIZE = 72;
/** Accept punches from 60% similarity upward (lighting/angle tolerant). */
const MATCH_THRESHOLD = 0.6;

function toPercent(score: number) {
  return Math.max(0, Math.min(100, Math.round(score * 100)));
}

async function loadBitmap(source: string | Blob): Promise<ImageBitmap> {
  if (typeof source !== "string") return createImageBitmap(source);
  const response = await fetch(source, { mode: "cors", credentials: "omit" });
  if (!response.ok) throw new Error("Unable to load profile photo for face match.");
  return createImageBitmap(await response.blob());
}

async function detectFaceBox(bitmap: ImageBitmap): Promise<FaceBox | null> {
  const FaceDetectorCtor = typeof window !== "undefined"
    ? (window as Window & { FaceDetector?: new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => { detect: (source: ImageBitmap) => Promise<Array<{ boundingBox: DOMRectReadOnly }>> } }).FaceDetector
    : undefined;
  if (FaceDetectorCtor) {
    try {
      const detector = new FaceDetectorCtor({ fastMode: false, maxDetectedFaces: 1 });
      const faces = await detector.detect(bitmap);
      const box = faces[0]?.boundingBox;
      if (box && box.width > 20 && box.height > 20) {
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }
    } catch {
      // Fall through to center crop.
    }
  }
  return null;
}

function portraitBox(bitmap: ImageBitmap, scale = 0.62): FaceBox {
  const size = Math.min(bitmap.width, bitmap.height) * scale;
  return {
    x: (bitmap.width - size) / 2,
    y: Math.max(0, bitmap.height * 0.1),
    width: size,
    height: size
  };
}

function faceVector(bitmap: ImageBitmap, box: FaceBox, mirror = false): Float32Array {
  const canvas = document.createElement("canvas");
  canvas.width = FACE_SIZE;
  canvas.height = FACE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Unable to process selfie for face match.");
  const pad = Math.min(box.width, box.height) * 0.2;
  const sx = Math.max(0, box.x - pad);
  const sy = Math.max(0, box.y - pad);
  const sw = Math.min(bitmap.width - sx, box.width + pad * 2);
  const sh = Math.min(bitmap.height - sy, box.height + pad * 2);
  if (mirror) {
    ctx.translate(FACE_SIZE, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, FACE_SIZE, FACE_SIZE);

  const { data } = ctx.getImageData(0, 0, FACE_SIZE, FACE_SIZE);
  const vector = new Float32Array(FACE_SIZE * FACE_SIZE);
  // Local contrast normalize in 8x8 blocks so lighting differences hurt less.
  const block = 8;
  for (let by = 0; by < FACE_SIZE; by += block) {
    for (let bx = 0; bx < FACE_SIZE; bx += block) {
      let sum = 0;
      let sumSq = 0;
      const cells: number[] = [];
      for (let y = by; y < by + block; y += 1) {
        for (let x = bx; x < bx + block; x += 1) {
          const o = (y * FACE_SIZE + x) * 4;
          const gray = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
          cells.push(gray);
          sum += gray;
          sumSq += gray * gray;
        }
      }
      const n = cells.length;
      const mean = sum / n;
      const variance = Math.max(sumSq / n - mean * mean, 1);
      const std = Math.sqrt(variance);
      let i = 0;
      for (let y = by; y < by + block; y += 1) {
        for (let x = bx; x < bx + block; x += 1) {
          vector[y * FACE_SIZE + x] = (cells[i] - mean) / std;
          i += 1;
        }
      }
    }
  }
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

function cosine(a: Float32Array, b: Float32Array) {
  let score = 0;
  for (let i = 0; i < a.length; i += 1) score += a[i] * b[i];
  return Math.max(0, Math.min(1, score));
}

function bestScore(profile: ImageBitmap, selfie: ImageBitmap, profileBoxes: FaceBox[], selfieBoxes: FaceBox[]) {
  let best = 0;
  for (const pBox of profileBoxes) {
    const profileVec = faceVector(profile, pBox, false);
    for (const sBox of selfieBoxes) {
      best = Math.max(best, cosine(profileVec, faceVector(selfie, sBox, false)));
      best = Math.max(best, cosine(profileVec, faceVector(selfie, sBox, true)));
    }
  }
  return best;
}

/** Compare a live selfie to the account profile photo in the browser. Does not upload either image. */
export async function matchSelfieToProfile(selfie: Blob, profilePhotoUrl: string | null | undefined): Promise<FaceMatchResult> {
  if (!profilePhotoUrl) {
    return { ok: false, score: 0, percent: 0, reason: "Add a profile photo first, then capture a selfie to punch." };
  }
  try {
    const [profileBitmap, selfieBitmap] = await Promise.all([loadBitmap(profilePhotoUrl), loadBitmap(selfie)]);
    const [detectedProfile, detectedSelfie] = await Promise.all([
      detectFaceBox(profileBitmap),
      detectFaceBox(selfieBitmap)
    ]);

    const profileBoxes = [
      detectedProfile,
      portraitBox(profileBitmap, 0.7),
      portraitBox(profileBitmap, 0.55)
    ].filter(Boolean) as FaceBox[];
    const selfieBoxes = [
      detectedSelfie,
      portraitBox(selfieBitmap, 0.7),
      portraitBox(selfieBitmap, 0.55)
    ].filter(Boolean) as FaceBox[];

    const score = bestScore(profileBitmap, selfieBitmap, profileBoxes, selfieBoxes);
    const percent = toPercent(score);

    if (score < MATCH_THRESHOLD) {
      return {
        ok: false,
        score,
        percent,
        reason: `Face match ${percent}% (need ${Math.round(MATCH_THRESHOLD * 100)}%+). Retake selfie facing the camera with similar lighting.`
      };
    }
    return {
      ok: true,
      score,
      percent,
      reason: `Face match ${percent}%`
    };
  } catch (error) {
    return {
      ok: false,
      score: 0,
      percent: 0,
      reason: error instanceof Error ? error.message : "Unable to match selfie to profile photo."
    };
  }
}
