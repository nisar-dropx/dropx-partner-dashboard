type FaceMatchResult = {
  ok: boolean;
  score: number;
  reason?: string;
};

type FaceBox = { x: number; y: number; width: number; height: number };

const FACE_SIZE = 64;
const MATCH_THRESHOLD = 0.78;

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
      const detector = new FaceDetectorCtor({ fastMode: true, maxDetectedFaces: 1 });
      const faces = await detector.detect(bitmap);
      const box = faces[0]?.boundingBox;
      if (box && box.width > 20 && box.height > 20) {
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }
    } catch {
      // Fall through to center crop.
    }
  }
  // Approximate face region (upper-center portrait) when FaceDetector is unavailable.
  const size = Math.min(bitmap.width, bitmap.height) * 0.55;
  return {
    x: (bitmap.width - size) / 2,
    y: Math.max(0, bitmap.height * 0.12),
    width: size,
    height: size
  };
}

function faceVector(bitmap: ImageBitmap, box: FaceBox): Float32Array {
  const canvas = document.createElement("canvas");
  canvas.width = FACE_SIZE;
  canvas.height = FACE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Unable to process selfie for face match.");
  const pad = Math.min(box.width, box.height) * 0.15;
  ctx.drawImage(
    bitmap,
    Math.max(0, box.x - pad),
    Math.max(0, box.y - pad),
    Math.min(bitmap.width, box.width + pad * 2),
    Math.min(bitmap.height, box.height + pad * 2),
    0,
    0,
    FACE_SIZE,
    FACE_SIZE
  );
  const { data } = ctx.getImageData(0, 0, FACE_SIZE, FACE_SIZE);
  const vector = new Float32Array(FACE_SIZE * FACE_SIZE);
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const o = i * 4;
    const gray = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    vector[i] = gray;
    sum += gray;
  }
  const mean = sum / vector.length;
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) {
    vector[i] -= mean;
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

function cosine(a: Float32Array, b: Float32Array) {
  let score = 0;
  for (let i = 0; i < a.length; i += 1) score += a[i] * b[i];
  return score;
}

/** Compare a live selfie to the account profile photo in the browser. Does not upload either image. */
export async function matchSelfieToProfile(selfie: Blob, profilePhotoUrl: string | null | undefined): Promise<FaceMatchResult> {
  if (!profilePhotoUrl) {
    return { ok: false, score: 0, reason: "Add a profile photo first, then capture a selfie to punch." };
  }
  try {
    const [profileBitmap, selfieBitmap] = await Promise.all([loadBitmap(profilePhotoUrl), loadBitmap(selfie)]);
    const [profileBox, selfieBox] = await Promise.all([detectFaceBox(profileBitmap), detectFaceBox(selfieBitmap)]);
    if (!profileBox) {
      return { ok: false, score: 0, reason: "No face found in your profile photo. Update your profile photo and try again." };
    }
    if (!selfieBox) {
      return { ok: false, score: 0, reason: "No face found in selfie. Face the camera and retake." };
    }
    const score = cosine(faceVector(profileBitmap, profileBox), faceVector(selfieBitmap, selfieBox));
    if (score < MATCH_THRESHOLD) {
      return {
        ok: false,
        score,
        reason: "Selfie does not match your profile photo. Retake the selfie facing the camera."
      };
    }
    return { ok: true, score };
  } catch (error) {
    return {
      ok: false,
      score: 0,
      reason: error instanceof Error ? error.message : "Unable to match selfie to profile photo."
    };
  }
}
