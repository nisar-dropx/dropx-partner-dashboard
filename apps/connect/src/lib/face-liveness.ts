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
  return (dist(p2, p6) + dist(p3, p5)) / (2 * dist(p1, p4));
}

function meanEar(points: Point[]) {
  const left = eyeAspectRatio(points, [36, 37, 38, 39, 40, 41]);
  const right = eyeAspectRatio(points, [42, 43, 44, 45, 46, 47]);
  return (left + right) / 2;
}

function yawRatio(points: Point[]) {
  const nose = points[30];
  const jawLeft = points[1];
  const jawRight = points[15];
  if (!nose || !jawLeft || !jawRight) return 0;
  const midX = (jawLeft.x + jawRight.x) / 2;
  const width = Math.max(1, Math.abs(jawRight.x - jawLeft.x));
  return (nose.x - midX) / width;
}

export async function sampleFacePose(video: HTMLVideoElement) {
  if (video.readyState < 2) return null;
  await ensureFaceModels();
  const faceapi = (
    window as Window & {
      faceapi?: {
        TinyFaceDetectorOptions: new (options?: { inputSize?: number; scoreThreshold?: number }) => unknown;
        detectSingleFace: (
          input: HTMLVideoElement,
          options?: unknown
        ) => {
          withFaceLandmarks: () => Promise<{ landmarks?: { positions?: Point[] } } | undefined>;
        };
      };
    }
  ).faceapi;
  if (!faceapi) return null;
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 });
  const detection = await faceapi.detectSingleFace(video, options).withFaceLandmarks();
  const positions = detection?.landmarks?.positions;
  if (!positions?.length) return null;
  return {
    ear: meanEar(positions),
    yaw: yawRatio(positions)
  };
}

/** Incremental liveness checker — rejects a still photo (no blink / no yaw motion). */
export function createLivenessTracker(challenge: LivenessChallenge) {
  if (challenge === "blink") {
    let closed = false;
    let blinks = 0;
    let openBaseline = 0.28;
    return {
      ingest(pose: { ear: number; yaw: number } | null) {
        if (!pose) return { passed: false, progress: blinks / 2, hint: "Center your face, then blink" };
        if (pose.ear > 0.22) openBaseline = Math.max(openBaseline, pose.ear);
        const closedThreshold = Math.min(0.19, openBaseline * 0.55);
        const openThreshold = Math.max(0.22, openBaseline * 0.75);
        if (!closed && pose.ear < closedThreshold) closed = true;
        else if (closed && pose.ear > openThreshold) {
          closed = false;
          blinks += 1;
        }
        return {
          passed: blinks >= 2,
          progress: Math.min(1, blinks / 2),
          hint: blinks >= 2 ? "Blink OK" : blinks === 1 ? "Blink once more" : "Blink naturally twice"
        };
      }
    };
  }

  const targetSign = challenge === "turn_left" ? -1 : 1;
  let sawTurn = false;
  let returned = false;
  const TURN = 0.12;
  const CENTER = 0.06;
  return {
    ingest(pose: { ear: number; yaw: number } | null) {
      if (!pose) {
        return {
          passed: false,
          progress: 0,
          hint: challenge === "turn_left" ? "Turn your head to your left" : "Turn your head to your right"
        };
      }
      if (!sawTurn && pose.yaw * targetSign >= TURN) sawTurn = true;
      if (sawTurn && Math.abs(pose.yaw) <= CENTER) returned = true;
      return {
        passed: sawTurn && returned,
        progress: returned ? 1 : sawTurn ? 0.6 : Math.min(0.5, Math.abs(pose.yaw) / TURN),
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
