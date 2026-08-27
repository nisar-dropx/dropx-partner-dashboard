import { ensureFaceModels } from "@/lib/face-match";

type Point = { x: number; y: number };

export type LivenessChallenge = "blink" | "turn_left" | "turn_right";

export const LIVENESS_CHALLENGES: LivenessChallenge[] = ["blink", "turn_left", "turn_right"];

export function livenessPrompt(step: LivenessChallenge) {
  switch (step) {
    case "blink":
      return "Blink naturally twice";
    case "turn_left":
      return "Turn your head slowly to your left, then face forward";
    case "turn_right":
      return "Turn your head slowly to your right, then face forward";
    default:
      return "Follow the on-screen instruction";
  }
}

function dist(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function eyeAspectRatio(points: Point[], indices: number[]) {
  const [p1, p2, p3, p4, p5, p6] = indices.map((i) => points[i]);
  if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) return 1;
  return (dist(p2, p6) + dist(p3, p5)) / (2 * Math.max(1e-3, dist(p1, p4)));
}

function meanEar(points: Point[]) {
  const left = eyeAspectRatio(points, [36, 37, 38, 39, 40, 41]);
  const right = eyeAspectRatio(points, [42, 43, 44, 45, 46, 47]);
  return (left + right) / 2;
}

/**
 * Positive yaw = nose toward the RIGHT of the raw camera frame.
 * Selfie video is CSS-mirrored (`scaleX(-1)`), so we invert yaw so
 * "turn left / right" match what the user sees on screen.
 */
function yawRatio(points: Point[], mirroredDisplay: boolean) {
  const nose = points[30];
  const jawLeft = points[1];
  const jawRight = points[15];
  if (!nose || !jawLeft || !jawRight) return 0;
  const midX = (jawLeft.x + jawRight.x) / 2;
  const width = Math.max(1, Math.abs(jawRight.x - jawLeft.x));
  const raw = (nose.x - midX) / width;
  return mirroredDisplay ? -raw : raw;
}

function readLandmarkPositions(landmarks: {
  positions?: Point[];
  getPositions?: () => Point[];
}): Point[] | null {
  const fromProp = landmarks.positions;
  if (Array.isArray(fromProp) && fromProp.length >= 68) return fromProp;
  const fromFn = landmarks.getPositions?.();
  if (Array.isArray(fromFn) && fromFn.length >= 68) return fromFn;
  return null;
}

/** Downscale the live frame so landmark detection stays fast enough to catch blinks. */
function frameCanvasFromVideo(video: HTMLVideoElement) {
  const srcW = video.videoWidth || 0;
  const srcH = video.videoHeight || 0;
  if (!srcW || !srcH) return null;
  const maxSide = 320;
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, width, height);
  return canvas;
}

export async function sampleFacePose(video: HTMLVideoElement, options?: { mirroredDisplay?: boolean }) {
  if (video.readyState < 2) return null;
  await ensureFaceModels();
  const faceapi = (
    window as Window & {
      faceapi?: {
        TinyFaceDetectorOptions: new (options?: { inputSize?: number; scoreThreshold?: number }) => unknown;
        detectSingleFace: (
          input: HTMLVideoElement | HTMLCanvasElement,
          options?: unknown
        ) => {
          withFaceLandmarks: () => Promise<
            | {
                landmarks?: {
                  positions?: Point[];
                  getPositions?: () => Point[];
                };
              }
            | undefined
          >;
        };
      };
    }
  ).faceapi;
  if (!faceapi) return null;

  const frame = frameCanvasFromVideo(video);
  const input = frame ?? video;
  // Small + fast: blinks last ~100–150ms; a slow detector misses them entirely.
  const detector = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.2 });
  try {
    const detection = await faceapi.detectSingleFace(input, detector).withFaceLandmarks();
    const positions = detection?.landmarks ? readLandmarkPositions(detection.landmarks) : null;
    if (!positions?.length) return null;
    return {
      ear: meanEar(positions),
      yaw: yawRatio(positions, options?.mirroredDisplay !== false)
    };
  } catch {
    return null;
  }
}

/** Incremental liveness checker — rejects a still photo (no blink / no yaw motion). */
export function createLivenessTracker(challenge: LivenessChallenge) {
  if (challenge === "blink") {
    let closed = false;
    let blinks = 0;
    let openBaseline = 0.28;
    let samples = 0;
    let faceHits = 0;
    let missStreak = 0;
    return {
      ingest(pose: { ear: number; yaw: number } | null) {
        if (!pose) {
          missStreak += 1;
          return {
            passed: false,
            progress: Math.min(0.15, faceHits / 20),
            hint: faceHits
              ? "Keep your face in the circle, then blink"
              : "Center your face in the circle"
          };
        }
        missStreak = 0;
        faceHits += 1;
        samples += 1;

        // Warm-up so we learn open-eye EAR before counting blinks.
        if (samples <= 6) {
          openBaseline = openBaseline * 0.6 + pose.ear * 0.4;
          return {
            passed: false,
            progress: Math.min(0.2, samples / 30),
            hint: "Face found — hold still, then blink twice"
          };
        }

        // Track open baseline only while eyes look open.
        if (!closed && pose.ear >= openBaseline * 0.9) {
          openBaseline = openBaseline * 0.9 + pose.ear * 0.1;
        }

        // Soft relative blink: ~12% EAR drop counts as closed (works on phones / soft blinks).
        const closedThreshold = Math.max(0.08, openBaseline * 0.88);
        const openThreshold = Math.max(closedThreshold + 0.015, openBaseline * 0.94);

        if (!closed && pose.ear <= closedThreshold) {
          closed = true;
        } else if (closed && pose.ear >= openThreshold) {
          closed = false;
          blinks += 1;
        }

        const progress = Math.min(1, 0.2 + (blinks / 2) * 0.8);
        return {
          passed: blinks >= 2,
          progress,
          hint:
            blinks >= 2
              ? "Blink OK"
              : blinks === 1
                ? "Blink once more"
                : closed
                  ? "Open your eyes…"
                  : "Blink naturally twice"
        };
      }
    };
  }

  const targetSign = challenge === "turn_left" ? -1 : 1;
  let sawTurn = false;
  let returned = false;
  const TURN = 0.07;
  const CENTER = 0.08;
  return {
    ingest(pose: { ear: number; yaw: number } | null) {
      if (!pose) {
        return {
          passed: false,
          progress: sawTurn ? 0.55 : 0,
          hint: challenge === "turn_left" ? "Turn your head to your left" : "Turn your head to your right"
        };
      }
      const signed = pose.yaw * targetSign;
      if (!sawTurn && signed >= TURN) sawTurn = true;
      if (sawTurn && Math.abs(pose.yaw) <= CENTER) returned = true;
      return {
        passed: sawTurn && returned,
        progress: returned ? 1 : sawTurn ? 0.65 : Math.min(0.55, Math.max(0, signed) / TURN),
        hint: returned
          ? "Head turn OK"
          : sawTurn
            ? "Face forward again"
            : challenge === "turn_left"
              ? "Turn your head slowly to your left"
              : "Turn your head slowly to your right"
      };
    }
  };
}
