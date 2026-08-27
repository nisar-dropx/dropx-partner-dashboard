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
      return "Look at the camera and blink once";
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

/**
 * face-api 68-pt landmarks often under-report eyelid closure.
 * Use the more-closed eye so a partial blink still registers.
 */
function meanEar(points: Point[]) {
  const left = eyeAspectRatio(points, [36, 37, 38, 39, 40, 41]);
  const right = eyeAspectRatio(points, [42, 43, 44, 45, 46, 47]);
  return Math.min(left, right);
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
  // Smaller = faster. Blinks are ~100–200ms; we need every frame we can get.
  const maxSide = 288;
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
  // 224 is the fastest TinyFaceDetector size that still lands eyes well.
  const detector = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.15 });
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
 * Blink is intentionally loose — manager reviews the stored selfie anyway.
 * We only need a quick live-face signal (small EAR dip), not strict anti-spoof.
 */
export function createLivenessTracker(challenge: LivenessChallenge) {
  if (challenge === "blink") {
    let blinks = 0;
    let samples = 0;
    let faceHits = 0;
    let openBaseline = 0.24;
    let earHistory: number[] = [];
    let inValley = false;
    let valleyMin = 1;
    let reopenCooldown = 0;
    let anchor: { cx: number; cy: number; faceW: number } | null = null;

    const BLINKS_NEEDED = 1;
    const HISTORY = 10;

    return {
      ingest(pose: FacePoseSample | null) {
        if (!pose) {
          return {
            passed: false,
            progress: Math.min(0.15, faceHits / 12),
            hint: faceHits ? "Keep your face in the circle, then blink" : "Center your face in the circle"
          };
        }
        faceHits += 1;
        samples += 1;

        if (!anchor || samples <= 2) {
          anchor = { cx: pose.cx, cy: pose.cy, faceW: pose.faceW };
          if (pose.ear > 0.1) {
            openBaseline = openBaseline * 0.3 + pose.ear * 0.7;
            earHistory.push(pose.ear);
          }
          return {
            passed: false,
            progress: Math.min(0.2, samples / 8),
            hint: "Blink once when ready"
          };
        }

        // Only reject extreme photo-wave motion; normal blink movement is fine.
        if (motionTooLarge(pose, anchor, { center: 0.22, scale: 0.55 })) {
          inValley = false;
          valleyMin = 1;
          earHistory = [];
          anchor = { cx: pose.cx, cy: pose.cy, faceW: pose.faceW };
          return {
            passed: false,
            progress: Math.min(0.3, blinks / BLINKS_NEEDED),
            hint: "Hold the phone steady and blink"
          };
        }

        anchor = {
          cx: anchor.cx * 0.8 + pose.cx * 0.2,
          cy: anchor.cy * 0.8 + pose.cy * 0.2,
          faceW: anchor.faceW * 0.8 + pose.faceW * 0.2
        };

        earHistory.push(pose.ear);
        if (earHistory.length > HISTORY) earHistory.shift();

        if (reopenCooldown > 0) {
          reopenCooldown -= 1;
          return {
            passed: blinks >= BLINKS_NEEDED,
            progress: blinks >= BLINKS_NEEDED ? 1 : 0.55,
            hint: blinks >= BLINKS_NEEDED ? "Blink OK" : "Blink once"
          };
        }

        if (pose.ear >= openBaseline * 0.85) {
          openBaseline = openBaseline * 0.7 + pose.ear * 0.3;
        }

        // Very loose: ~5% dip (min 0.008) is enough — managers review the photo.
        const dropNeeded = Math.max(0.008, openBaseline * 0.05);
        const closedCut = openBaseline - dropNeeded;
        const openCut = openBaseline - dropNeeded * 0.2;

        // Also accept any clear min/max swing in the short window (noisy webcams).
        if (!inValley && earHistory.length >= 4) {
          const hi = Math.max(...earHistory);
          const lo = Math.min(...earHistory.slice(-5));
          if (hi - lo >= dropNeeded && pose.ear <= hi - dropNeeded * 0.6) {
            inValley = true;
            valleyMin = pose.ear;
          }
        }

        if (!inValley && pose.ear <= closedCut) {
          inValley = true;
          valleyMin = pose.ear;
        } else if (inValley) {
          valleyMin = Math.min(valleyMin, pose.ear);
          if (pose.ear >= openCut || pose.ear >= valleyMin + dropNeeded * 0.5) {
            if (openBaseline - valleyMin >= dropNeeded * 0.7 || Math.max(...earHistory) - valleyMin >= dropNeeded) {
              blinks += 1;
              inValley = false;
              valleyMin = 1;
              reopenCooldown = 2;
              earHistory = earHistory.slice(-2);
            }
          }
        }

        const progress = Math.min(1, 0.25 + (blinks / BLINKS_NEEDED) * 0.75);
        return {
          passed: blinks >= BLINKS_NEEDED,
          progress,
          hint: blinks >= BLINKS_NEEDED ? "Blink OK" : inValley ? "Open your eyes…" : "Blink once"
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
