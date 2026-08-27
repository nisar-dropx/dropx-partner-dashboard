import { ensureFaceModels } from "@/lib/face-match";

type Point = { x: number; y: number };

export type LivenessChallenge = "blink" | "turn_left" | "turn_right";

export const LIVENESS_CHALLENGES: LivenessChallenge[] = ["blink", "turn_left", "turn_right"];

export type FacePoseSample = {
  ear: number;
  yaw: number;
  /** Normalized face center X in the sample frame (0–1). */
  cx: number;
  /** Normalized face center Y in the sample frame (0–1). */
  cy: number;
  /** Normalized face width (0–1) — used to reject photo zoom / distance shake. */
  faceW: number;
};

export function livenessPrompt(step: LivenessChallenge) {
  switch (step) {
    case "blink":
      return "Hold still and blink naturally twice";
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

function faceBox(points: Point[], frameW: number, frameH: number) {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  return {
    cx: (minX + w / 2) / Math.max(1, frameW),
    cy: (minY + h / 2) / Math.max(1, frameH),
    faceW: w / Math.max(1, frameW)
  };
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
  const maxSide = 400;
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

export async function sampleFacePose(
  video: HTMLVideoElement,
  options?: { mirroredDisplay?: boolean }
): Promise<FacePoseSample | null> {
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
  const frameW = frame?.width || video.videoWidth || 1;
  const frameH = frame?.height || video.videoHeight || 1;
  // Slightly larger input keeps eye landmarks stable enough to catch blinks.
  const detector = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.2 });
  try {
    const detection = await faceapi.detectSingleFace(input, detector).withFaceLandmarks();
    const positions = detection?.landmarks ? readLandmarkPositions(detection.landmarks) : null;
    if (!positions?.length) return null;
    const box = faceBox(positions, frameW, frameH);
    return {
      ear: meanEar(positions),
      yaw: yawRatio(positions, options?.mirroredDisplay !== false),
      cx: box.cx,
      cy: box.cy,
      faceW: box.faceW
    };
  } catch {
    return null;
  }
}

function motionTooLarge(
  pose: FacePoseSample,
  anchor: { cx: number; cy: number; faceW: number },
  limits: { center: number; scale: number }
) {
  const centerMove = Math.hypot(pose.cx - anchor.cx, pose.cy - anchor.cy);
  const scaleMove = Math.abs(pose.faceW - anchor.faceW) / Math.max(0.05, anchor.faceW);
  return centerMove > limits.center || scaleMove > limits.scale;
}

/**
 * Incremental liveness checker.
 * Rejects still photos and "shake a printed photo" spoofs by requiring:
 * - blink: EAR drop while face center/size stay reasonably stable
 * - turn: yaw change with controlled motion, then return to center
 */
export function createLivenessTracker(challenge: LivenessChallenge) {
  if (challenge === "blink") {
    let closed = false;
    let closedFrames = 0;
    let blinks = 0;
    let openBaseline = 0.28;
    let samples = 0;
    let faceHits = 0;
    let anchor: { cx: number; cy: number; faceW: number } | null = null;
    let hardShakeHits = 0;
    let reopenCooldown = 0;
    return {
      ingest(pose: FacePoseSample | null) {
        if (!pose) {
          // Do not wipe a half-finished blink on a single missed frame.
          return {
            passed: false,
            progress: Math.min(0.12, faceHits / 25),
            hint: faceHits ? "Keep your face in the circle, then blink" : "Center your face in the circle"
          };
        }
        faceHits += 1;
        samples += 1;

        if (!anchor || samples <= 6) {
          anchor = { cx: pose.cx, cy: pose.cy, faceW: pose.faceW };
          // Warm baseline from open-eye samples only.
          if (pose.ear > 0.16) openBaseline = openBaseline * 0.5 + pose.ear * 0.5;
          return {
            passed: false,
            progress: Math.min(0.18, samples / 30),
            hint: "Hold still — then blink naturally twice"
          };
        }

        // Hard shake = waving a printed photo. Soft motion is normal while blinking.
        const hardShake = motionTooLarge(pose, anchor, { center: 0.1, scale: 0.32 });
        if (hardShake) {
          hardShakeHits += 1;
          closed = false;
          closedFrames = 0;
          reopenCooldown = 0;
          anchor = { cx: pose.cx, cy: pose.cy, faceW: pose.faceW };
          return {
            passed: false,
            progress: Math.min(0.25, blinks / 2),
            hint: "Hold still — do not shake the camera or a photo"
          };
        }

        // Slowly refresh anchor while stable so natural micro-motion is OK.
        anchor = {
          cx: anchor.cx * 0.9 + pose.cx * 0.1,
          cy: anchor.cy * 0.9 + pose.cy * 0.1,
          faceW: anchor.faceW * 0.9 + pose.faceW * 0.1
        };

        if (!closed && pose.ear >= openBaseline * 0.9) {
          openBaseline = openBaseline * 0.9 + pose.ear * 0.1;
        }

        // Real blinks often drop EAR ~20–40%. Keep this sensitive enough for webcam landmarks.
        const closedThreshold = Math.max(0.12, Math.min(0.22, openBaseline * 0.86));
        const openThreshold = Math.max(closedThreshold + 0.02, openBaseline * 0.92);

        if (reopenCooldown > 0) reopenCooldown -= 1;

        if (!closed && reopenCooldown === 0 && pose.ear <= closedThreshold) {
          closed = true;
          closedFrames = 1;
        } else if (closed && pose.ear <= closedThreshold) {
          closedFrames += 1;
        } else if (closed && pose.ear >= openThreshold) {
          // One closed sample is enough — natural blinks are often <150ms.
          if (closedFrames >= 1) {
            blinks += 1;
            reopenCooldown = 3; // avoid double-counting the same blink
          }
          closed = false;
          closedFrames = 0;
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
                  : hardShakeHits
                    ? "Hold still and blink (not a photo)"
                    : "Hold still and blink naturally twice"
        };
      }
    };
  }

  const targetSign = challenge === "turn_left" ? -1 : 1;
  let sawTurn = false;
  let returned = false;
  let peakYaw = 0;
  let samples = 0;
  let anchor: { cx: number; cy: number; faceW: number } | null = null;
  const TURN = 0.11;
  const CENTER = 0.07;
  return {
    ingest(pose: FacePoseSample | null) {
      if (!pose) {
        return {
          passed: false,
          progress: sawTurn ? 0.5 : 0,
          hint: challenge === "turn_left" ? "Turn your head to your left" : "Turn your head to your right"
        };
      }
      samples += 1;
      if (!anchor || samples <= 5) {
        anchor = { cx: pose.cx, cy: pose.cy, faceW: pose.faceW };
        return {
          passed: false,
          progress: 0.1,
          hint: challenge === "turn_left" ? "Face forward, then turn left" : "Face forward, then turn right"
        };
      }

      // Reject paper/phone shake: huge translation or zoom without a clean yaw ramp.
      if (motionTooLarge(pose, anchor, { center: 0.12, scale: 0.28 })) {
        sawTurn = false;
        returned = false;
        peakYaw = 0;
        anchor = { cx: pose.cx, cy: pose.cy, faceW: pose.faceW };
        return {
          passed: false,
          progress: 0.15,
          hint: "Turn your head only — do not wave a photo"
        };
      }

      const signed = pose.yaw * targetSign;
      peakYaw = Math.max(peakYaw, signed);
      if (!sawTurn && signed >= TURN) sawTurn = true;
      if (sawTurn && Math.abs(pose.yaw) <= CENTER && peakYaw >= TURN) returned = true;

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
