"use client";

import { Camera, Check, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  FACE_MATCH_REQUIRED_PERCENT,
  ensureFaceModels,
  matchLiveFrameToProfile,
  type FaceMatchResult
} from "@/lib/face-match";
import {
  LIVENESS_CHALLENGES,
  createLivenessTracker,
  livenessPrompt,
  sampleFacePose,
  type LivenessChallenge
} from "@/lib/face-liveness";

type SelfieCapturePanelProps = {
  title?: string;
  hint?: string;
  profilePhotoUrl?: string | null;
  /** When true, face match must pass before liveness / capture. */
  requireFaceMatch?: boolean;
  /** Blink + head-turn challenge to reduce photo/screen spoofing. Default: on when face match required, or always if set. */
  requireLiveness?: boolean;
  onCapture: (file: File, match: FaceMatchResult | null) => void | Promise<void>;
  onClose: () => void;
};

type Phase = "match" | "liveness" | "ready";

export function SelfieCapturePanel({
  title = "Face verification",
  hint = "Match your profile face first, then complete live checks, then capture.",
  profilePhotoUrl,
  requireFaceMatch = false,
  requireLiveness,
  onCapture,
  onClose
}: SelfieCapturePanelProps) {
  const needLiveness = requireLiveness ?? requireFaceMatch;
  const needMatch = Boolean(requireFaceMatch && profilePhotoUrl);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackerRef = useRef<ReturnType<typeof createLivenessTracker> | null>(null);
  const challengeIndexRef = useRef(0);
  const matchOkStreakRef = useRef(0);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(Boolean(needMatch || needLiveness));
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [liveMatch, setLiveMatch] = useState<FaceMatchResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [phase, setPhase] = useState<Phase>(needMatch ? "match" : needLiveness ? "liveness" : "ready");
  const [challengeIndex, setChallengeIndex] = useState(0);
  const [livenessDone, setLivenessDone] = useState(!needLiveness);
  const [livenessHint, setLivenessHint] = useState("");
  const [livenessProgress, setLivenessProgress] = useState(0);
  const [matchProgress, setMatchProgress] = useState(0);

  challengeIndexRef.current = challengeIndex;

  const challenge: LivenessChallenge | null =
    phase === "liveness" && needLiveness && !livenessDone
      ? LIVENESS_CHALLENGES[Math.min(challengeIndex, LIVENESS_CHALLENGES.length - 1)]
      : null;

  useEffect(() => {
    if (!needMatch && !needLiveness) {
      setModelsLoading(false);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    ensureFaceModels()
      .then(() => {
        if (!cancelled) setModelsLoading(false);
      })
      .catch((reason) => {
        if (!cancelled) {
          setModelsLoading(false);
          setError(reason instanceof Error ? reason.message : "Unable to load face model.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [needMatch, needLiveness]);

  useEffect(() => {
    if (requireFaceMatch && !profilePhotoUrl) {
      setError("Profile photo is missing. Upload a profile photo before support selfie.");
    }
  }, [requireFaceMatch, profilePhotoUrl]);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      setError("");
      setReady(false);
      setLiveMatch(null);
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Camera is not supported in this browser.");
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "user" },
            width: { ideal: 720 },
            height: { ideal: 720 }
          }
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
          setReady(true);
        }
      } catch (reason) {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.name === "NotAllowedError" || reason.message.includes("Permission")
                ? "Camera permission denied. Allow camera access in browser settings."
                : reason.message
              : "Unable to open camera."
          );
        }
      }
    }
    if (!previewUrl) start().catch(() => undefined);
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [previewUrl]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Phase 1 — face match first (identity), before any liveness.
  useEffect(() => {
    if (phase !== "match" || !needMatch || !profilePhotoUrl || !ready || previewUrl || modelsLoading) return;
    let cancelled = false;
    let busy = false;
    const tick = async () => {
      const video = videoRef.current;
      if (!video || cancelled || busy || video.readyState < 2) return;
      busy = true;
      try {
        const result = await matchLiveFrameToProfile(video, profilePhotoUrl);
        if (cancelled) return;
        setLiveMatch(result);
        if (result.ok) {
          matchOkStreakRef.current += 1;
          setMatchProgress(Math.min(1, matchOkStreakRef.current / 3));
          // Require a few consecutive good matches so a single lucky frame cannot skip.
          if (matchOkStreakRef.current >= 3) {
            setPhase(needLiveness ? "liveness" : "ready");
            setLivenessDone(!needLiveness);
          }
        } else {
          matchOkStreakRef.current = 0;
          setMatchProgress(result.percent > 0 ? Math.min(0.6, result.percent / 100) : 0);
        }
      } finally {
        busy = false;
      }
    };
    tick().catch(() => undefined);
    const timer = window.setInterval(() => {
      tick().catch(() => undefined);
    }, 450);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, needMatch, needLiveness, profilePhotoUrl, ready, previewUrl, modelsLoading]);

  // Reset tracker when the active challenge changes.
  useEffect(() => {
    if (phase !== "liveness" || !needLiveness || livenessDone || !challenge) {
      trackerRef.current = null;
      return;
    }
    trackerRef.current = createLivenessTracker(challenge);
    setLivenessHint(livenessPrompt(challenge));
    setLivenessProgress(0);
  }, [phase, needLiveness, livenessDone, challenge]);

  // Phase 2 — liveness after identity match.
  // Sample as fast as detection finishes (not a fixed interval). Fixed timers
  // + busy locks drop frames and miss ~100–200ms natural blinks.
  useEffect(() => {
    if (phase !== "liveness" || !needLiveness || livenessDone || !ready || previewUrl || modelsLoading) return;
    let cancelled = false;
    let timer = 0;

    const schedule = (delayMs: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        tick().catch(() => undefined);
      }, delayMs);
    };

    const tick = async () => {
      const video = videoRef.current;
      if (!video || cancelled || !trackerRef.current) return;
      const started = performance.now();
      try {
        const pose = await sampleFacePose(video, { mirroredDisplay: true });
        if (cancelled || !trackerRef.current) return;
        const result = trackerRef.current.ingest(pose);
        setLivenessHint(result.hint);
        setLivenessProgress(result.progress);
        if (result.passed) {
          const next = challengeIndexRef.current + 1;
          if (next >= LIVENESS_CHALLENGES.length) {
            setLivenessDone(true);
            setPhase("ready");
            setLivenessHint("Live checks passed — capture your selfie");
            setLivenessProgress(1);
            return;
          }
          setChallengeIndex(next);
        }
      } finally {
        if (!cancelled) {
          // Aim for ~15–20 samples/sec when the model is fast; never stack overlap.
          const elapsed = performance.now() - started;
          schedule(Math.max(16, 50 - elapsed));
        }
      }
    };

    schedule(0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [phase, needLiveness, livenessDone, ready, previewUrl, modelsLoading]);

  async function snap() {
    const video = videoRef.current;
    if (!video || !ready || capturing) return;
    if (needMatch && phase === "match") {
      setError("Match your face to your profile photo first.");
      return;
    }
    if (needLiveness && !livenessDone) {
      setError("Complete the live checks (blink and head turns) before capturing.");
      return;
    }
    setCapturing(true);
    setError("");
    try {
      const size = Math.min(video.videoWidth, video.videoHeight);
      if (!size) throw new Error("Camera is still starting. Try again.");
      const sx = (video.videoWidth - size) / 2;
      const sy = (video.videoHeight - size) / 2;

      // Match on an unmirrored crop — same orientation pipeline as the live video feed.
      const matchCanvas = document.createElement("canvas");
      matchCanvas.width = size;
      matchCanvas.height = size;
      const matchCtx = matchCanvas.getContext("2d");
      if (!matchCtx) throw new Error("Unable to capture selfie.");
      matchCtx.drawImage(video, sx, sy, size, size, 0, 0, size, size);

      let match: FaceMatchResult | null = liveMatch;
      if (needMatch && profilePhotoUrl) {
        setChecking(true);
        match = await matchLiveFrameToProfile(matchCanvas, profilePhotoUrl);
        setChecking(false);
        if (!match.ok) {
          setError(
            match.reason ||
              `Face match ${match.percent}% in this frame — hold still facing the camera and tap Capture again.`
          );
          return;
        }
        setLiveMatch(match);
      }

      const outCanvas = document.createElement("canvas");
      outCanvas.width = size;
      outCanvas.height = size;
      const outCtx = outCanvas.getContext("2d");
      if (!outCtx) throw new Error("Unable to capture selfie.");
      outCtx.translate(size, 0);
      outCtx.scale(-1, 1);
      outCtx.drawImage(video, sx, sy, size, size, 0, 0, size, size);

      const blob = await new Promise<Blob | null>((resolve) => outCanvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("Unable to capture selfie.");
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewBlob(blob);
      setPreviewUrl(URL.createObjectURL(blob));
      setReady(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to capture selfie.");
    } finally {
      setChecking(false);
      setCapturing(false);
    }
  }

  function retake() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl("");
    setPreviewBlob(null);
    setError("");
    setLiveMatch(null);
    setChallengeIndex(0);
    setLivenessDone(!needLiveness);
    setLivenessHint("");
    setLivenessProgress(0);
    setMatchProgress(0);
    matchOkStreakRef.current = 0;
    setPhase(needMatch ? "match" : needLiveness ? "liveness" : "ready");
  }

  async function confirm() {
    if (!previewBlob) return;
    if (needMatch && (!liveMatch || !liveMatch.ok)) {
      setError(`Face match must be ${FACE_MATCH_REQUIRED_PERCENT}%+ before using this selfie.`);
      return;
    }
    if (needLiveness && !livenessDone) {
      setError("Live checks are required.");
      return;
    }
    const file = new File([previewBlob], `attendance-selfie-${Date.now()}.jpg`, { type: "image/jpeg" });
    setCapturing(true);
    setError("");
    try {
      await onCapture(file, liveMatch);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to use this selfie.");
    } finally {
      setCapturing(false);
    }
  }

  const captureEnabled =
    ready &&
    !capturing &&
    !checking &&
    !modelsLoading &&
    phase === "ready" &&
    (!needLiveness || livenessDone) &&
    (!needMatch || Boolean(liveMatch?.ok));

  const guide =
    previewUrl
      ? liveMatch?.ok
        ? `Matched ${liveMatch.percent}% — you can use this selfie`
        : "Check that your face fills the circle clearly."
      : phase === "match"
        ? liveMatch
          ? liveMatch.ok
            ? matchProgress >= 1
              ? `Matched ${liveMatch.percent}% — starting live checks…`
              : `Matched ${liveMatch.percent}% — hold still (${Math.min(3, Math.max(1, Math.round(matchProgress * 3)))}/3)`
            : liveMatch.percent > 0
              ? `Match ${liveMatch.percent}% — need ${FACE_MATCH_REQUIRED_PERCENT}%+`
              : liveMatch.reason || "Align your face with your profile photo"
          : modelsLoading
            ? "Loading face model..."
            : "Hold still — match your profile face first"
        : phase === "liveness"
          ? livenessHint || (challenge ? livenessPrompt(challenge) : "Live check…")
          : "Live checks passed — capture your selfie";

  const stepLabel =
    phase === "match"
      ? "Step 1/3 · Face match"
      : phase === "liveness"
        ? `Step 2/3 · Live check ${Math.min(challengeIndex + 1, LIVENESS_CHALLENGES.length)}/${LIVENESS_CHALLENGES.length}`
        : "Step 3/3 · Capture";

  const scorePct =
    phase === "match"
      ? Math.round(matchProgress * 100)
      : phase === "liveness"
        ? Math.round(livenessProgress * 100)
        : 100;

  return (
    <>
      <button aria-label="Close selfie panel" className="dx-sheet-scrim" onClick={onClose} type="button" />
      <aside className="dx-selfie-panel" role="dialog" aria-modal="true" aria-labelledby="selfie-panel-title">
        <header>
          <div>
            <strong id="selfie-panel-title">{title}</strong>
            <small>{hint}</small>
          </div>
          <button aria-label="Close" onClick={onClose} type="button">
            <X />
          </button>
        </header>

        <div className="dx-selfie-stage">
          <div
            className={`dx-selfie-frame ${
              phase === "ready" || (phase === "match" && liveMatch?.ok)
                ? "ok"
                : liveMatch && liveMatch.percent > 0 && !liveMatch.ok
                  ? "warn"
                  : ""
            }`}
          >
            {previewUrl ? (
              <img alt="Selfie preview" className="dx-selfie-live" src={previewUrl} />
            ) : (
              <video autoPlay className="dx-selfie-live" muted playsInline ref={videoRef} />
            )}
            <div aria-hidden className="dx-selfie-mask">
              <div className="dx-selfie-circle" />
            </div>
          </div>
          <p className={`dx-selfie-guide ${phase === "ready" ? "ok" : ""}`}>{guide}</p>
          {!previewUrl ? (
            <div className={`dx-selfie-score ${phase === "ready" ? "ok" : "warn"}`} aria-live="polite">
              <strong>{stepLabel}</strong>
              <span>{scorePct}%</span>
            </div>
          ) : null}
          {needMatch && phase !== "match" && liveMatch && liveMatch.percent > 0 ? (
            <div className={`dx-selfie-score ${liveMatch.ok ? "ok" : "warn"}`} aria-live="polite">
              <strong>{liveMatch.percent}%</strong>
              <span>{liveMatch.ok ? "face match" : `need ${FACE_MATCH_REQUIRED_PERCENT}%+`}</span>
            </div>
          ) : null}
        </div>

        {error ? <p className="dx-form-error">{error}</p> : null}

        <div className="dx-selfie-panel-actions">
          {previewUrl ? (
            <>
              <button className="secondary" onClick={retake} type="button">
                <RefreshCw /> Retake
              </button>
              <button disabled={needMatch && !liveMatch?.ok} onClick={confirm} type="button">
                <Check /> Use selfie
              </button>
            </>
          ) : (
            <>
              <button className="secondary" onClick={onClose} type="button">
                Cancel
              </button>
              <button disabled={!captureEnabled} onClick={snap} type="button">
                <Camera />
                {modelsLoading
                  ? "Loading model..."
                  : phase === "match"
                    ? "Match face first…"
                    : phase === "liveness"
                      ? "Complete live checks…"
                      : checking
                        ? "Matching..."
                        : capturing
                          ? "Capturing..."
                          : ready
                            ? "Capture"
                            : "Starting camera..."}
              </button>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
