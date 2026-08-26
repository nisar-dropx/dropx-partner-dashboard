export type FaceMatchResult = {
  ok: boolean;
  score: number;
  percent: number;
  reason?: string;
  engine?: "face-api";
};

type FaceApi = {
  nets: {
    tinyFaceDetector: { loadFromUri: (url: string) => Promise<unknown> };
    faceLandmark68Net: { loadFromUri: (url: string) => Promise<unknown> };
    faceRecognitionNet: { loadFromUri: (url: string) => Promise<unknown> };
  };
  TinyFaceDetectorOptions: new (options?: { inputSize?: number; scoreThreshold?: number }) => unknown;
  detectSingleFace: (
    input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
    options?: unknown
  ) => {
    withFaceLandmarks: () => {
      withFaceDescriptor: () => Promise<{ descriptor: Float32Array } | undefined>;
    };
  };
  euclideanDistance: (a: Float32Array, b: Float32Array) => number;
};

const MATCH_PERCENT_REQUIRED = 60;
/** Euclidean distance mapped to % — 0 → 100%, 0.85 → 0%. Same person is often < 0.45. */
const MAX_DISTANCE_FOR_0 = 0.85;
const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model";
const SCRIPT_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.min.js";

let modelsReady: Promise<FaceApi> | null = null;
const profileDescriptorCache = new Map<string, Float32Array>();

function toPercentFromDistance(distance: number) {
  const raw = ((MAX_DISTANCE_FOR_0 - distance) / MAX_DISTANCE_FOR_0) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[data-face-api="1"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.faceApi = "1";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Unable to load face recognition model."));
    document.head.appendChild(script);
  });
}

export async function ensureFaceModels() {
  if (!modelsReady) {
    modelsReady = (async () => {
      await loadScript(SCRIPT_URL);
      const faceapi = (window as Window & { faceapi?: FaceApi }).faceapi;
      if (!faceapi) throw new Error("Face recognition library failed to initialize.");
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
      ]);
      return faceapi;
    })().catch((error) => {
      modelsReady = null;
      throw error;
    });
  }
  return modelsReady;
}

async function blobOrUrlToImage(source: string | Blob): Promise<HTMLImageElement> {
  if (typeof source === "string") {
    const response = await fetch(source, { mode: "cors", credentials: "omit" });
    if (!response.ok) throw new Error("Unable to load profile photo for face match.");
    const blobUrl = URL.createObjectURL(await response.blob());
    try {
      return await decodeImage(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }
  const url = URL.createObjectURL(source);
  try {
    return await decodeImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function decodeImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to decode photo for face match."));
    image.src = url;
  });
}

function mirrorCanvas(image: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement) {
  const width =
    image instanceof HTMLVideoElement
      ? image.videoWidth || image.clientWidth
      : image.width;
  const height =
    image instanceof HTMLVideoElement
      ? image.videoHeight || image.clientHeight
      : image.height;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Unable to process selfie frame.");
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function descriptorFrom(
  faceapi: FaceApi,
  input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement
) {
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.35 });
  const detection = await faceapi
    .detectSingleFace(input, options)
    .withFaceLandmarks()
    .withFaceDescriptor();
  return detection?.descriptor ?? null;
}

async function bestDistance(
  faceapi: FaceApi,
  profileDesc: Float32Array,
  live: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement
) {
  const direct = await descriptorFrom(faceapi, live);
  const mirrored = await descriptorFrom(faceapi, mirrorCanvas(live));
  let best = Number.POSITIVE_INFINITY;
  if (direct) best = Math.min(best, faceapi.euclideanDistance(profileDesc, direct));
  if (mirrored) best = Math.min(best, faceapi.euclideanDistance(profileDesc, mirrored));
  return best;
}

export async function getProfileDescriptor(profilePhotoUrl: string) {
  const cached = profileDescriptorCache.get(profilePhotoUrl);
  if (cached) return cached;
  const faceapi = await ensureFaceModels();
  const image = await blobOrUrlToImage(profilePhotoUrl);
  const descriptor = await descriptorFrom(faceapi, image);
  if (!descriptor) throw new Error("No face found in your profile photo. Update your profile photo and try again.");
  profileDescriptorCache.set(profilePhotoUrl, descriptor);
  return descriptor;
}

/** Match a live video/canvas/image/blob frame against the profile photo. */
export async function matchLiveFrameToProfile(
  frame: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement | Blob,
  profilePhotoUrl: string | null | undefined
): Promise<FaceMatchResult> {
  if (!profilePhotoUrl) {
    return {
      ok: false,
      score: 0,
      percent: 0,
      reason: "Add a profile photo first, then capture a selfie to punch.",
      engine: "face-api"
    };
  }
  try {
    const faceapi = await ensureFaceModels();
    const profileDesc = await getProfileDescriptor(profilePhotoUrl);
    const input = frame instanceof Blob ? await blobOrUrlToImage(frame) : frame;
    if ("readyState" in input && input.readyState < 2) {
      return {
        ok: false,
        score: 0,
        percent: 0,
        reason: "Camera is still starting...",
        engine: "face-api"
      };
    }
    const distance = await bestDistance(faceapi, profileDesc, input);
    if (!Number.isFinite(distance)) {
      return {
        ok: false,
        score: 0,
        percent: 0,
        reason: "No face detected. Center your face in the circle.",
        engine: "face-api"
      };
    }
    const percent = toPercentFromDistance(distance);
    const ok = percent >= MATCH_PERCENT_REQUIRED;
    return {
      ok,
      score: Math.max(0, 1 - distance / MAX_DISTANCE_FOR_0),
      percent,
      engine: "face-api",
      reason: ok
        ? `Face match ${percent}%`
        : `Face match ${percent}% (need ${MATCH_PERCENT_REQUIRED}%+). Hold steady and face the camera.`
    };
  } catch (error) {
    return {
      ok: false,
      score: 0,
      percent: 0,
      engine: "face-api",
      reason: error instanceof Error ? error.message : "Unable to match face."
    };
  }
}

export async function matchSelfieToProfile(
  selfie: Blob,
  profilePhotoUrl: string | null | undefined
): Promise<FaceMatchResult> {
  return matchLiveFrameToProfile(selfie, profilePhotoUrl);
}

export const FACE_MATCH_REQUIRED_PERCENT = MATCH_PERCENT_REQUIRED;
