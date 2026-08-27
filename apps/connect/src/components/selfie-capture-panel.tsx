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
  /** When true, Use selfie stays disabled until face match >= required %. */
  requireFaceMatch?: boolean;
  /** Blink + head-turn challenge to reduce photo/screen spoofing. Default: on when face match required, or always if set. */
  requireLiveness?: boolean;
  onCapture: (file: File, match: FaceMatchResult | null) => void;
  onClose: () => void;
};

export function SelfieCapturePanel({
  title = "Face verification",
  hint = "Center your face inside the circle. Complete the live checks, then capture.",
  profilePhotoUrl,
  requireFaceMatch = false,
  requireLiveness,
  onCapture,
  onClose
}: SelfieCapturePanelProps) {
  const needLiveness = requireLiveness ?? requireFaceMatch;
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackerRef = useRef<ReturnType<typeof createLivenessTracker> | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(Boolean((requireFaceMatch || needLiveness) && true));
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [liveMatch, setLiveMatch] = useState<FaceMatchResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [challengeIndex, setChallengeIndex] = useState(0);
  const [livenessDone, setLivenessDone] = useState(!needLiveness);
  const [livenessHint, setLivenessHint] = useState("");
  const [livenessProgress, setLivenessProgress] = useState(0);

  const challenge: LivenessChallenge | null = needLiveness && !livenessDone
    ? LIVENESS_CHALLENGES[Math.min(challengeIndex, LIVENESS_CHALLENGES.length - 1)]
    : null;

  useEffect(() => {
    if (!requireFaceMatch && !needLiveness) {
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
  }, [requireFaceMatch, needLiveness]);

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
            width: { ideal: 1280 },
            height: { ideal: 1280 }
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

  // Reset / advance liveness tracker when challenge changes.
  useEffect(() => {
    if (!needLiveness || livenessDone || !challenge) {
      trackerRef.current = null;
      return;
    }
    trackerRef.current = createLivenessTracker(challenge);
    setLivenessHint(livenessPrompt(challenge));
    setLivenessProgress(0);
  }, [needLiveness, livenessDone, challenge]);

  // Liveness sampling loop (must pass before capture when enabled).
  useEffect(() => {
    if (!needLiveness || livenessDone || !ready || previewUrl || modelsLoading || !challenge) return;
    let cancelled = false;
    let busy = false;
    const tick = async () => {
      const video = videoRef.current;
      if (!video || cancelled || busy) return;
      busy = true;
      try {
        const pose = await sampleFacePose(video, { mirroredDisplay: true });
        if (cancelled || !trackerRef.current) return;
        const result = trackerRef.current.ingest(pose);
        setLivenessHint(result.hint);
        setLivenessProgress(result.progress);
        if (result.passed) {
          const next = challengeIndex + 1;
          if (next >= LIVENESS_CHALLENGES.length) {
            setLivenessDone(true);
            setLivenessHint("Live checks passed — capture your selfie");
            setLivenessProgress(1);
          } else {
            setChallengeIndex(next);
          }
        }
      } finally {
        busy = false;
      }
    };
    tick().catch(() => undefined);
    const timer = window.setInterval(() => {
      tick().catch(() => undefined);
    }, 180);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [needLiveness, livenessDone, ready, previewUrl, modelsLoading, challenge, challengeIndex]);

  // Live match while camera is open (after liveness when required).
  useEffect(() => {
    if (!requireFaceMatch || !profilePhotoUrl || !ready || previewUrl || modelsLoading) return;
    if (needLiveness && !livenessDone) return;
    let cancelled = false;
    let busy = false;
    const tick = async () => {
      const video = videoRef.current;
      if (!video || cancelled || busy || video.readyState < 2) return;
      busy = true;
      try {
        const result = await matchLiveFrameToProfile(video, profilePhotoUrl);
        if (!cancelled) setLiveMatch(result);
      } finally {
        busy = false;
      }
    };
    tick().catch(() => undefined);
    const timer = window.setInterval(() => {
      tick().catch(() => undefined);
    }, 700);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [requireFaceMatch, profilePhotoUrl, ready, previewUrl, modelsLoading, needLiveness, livenessDone]);

  async function snap() {
    const video = videoRef.current;
    if (!video || !ready || capturing) return;
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
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Unable to capture selfie.");
      ctx.translate(size, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, sx, sy, size, size, 0, 0, size, size);

      let match: FaceMatchResult | null = null;
      if (requireFaceMatch && profilePhotoUrl) {
        setChecking(true);
        match = await matchLiveFrameToProfile(canvas, profilePhotoUrl);
        setLiveMatch(match);
        setChecking(false);
        if (!match.ok) {
          setError(match.reason || `Face match ${match.percent}% — need ${FACE_MATCH_REQUIRED_PERCENT}%+.`);
          return;
        }
      }

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("Unable to capture selfie.");
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewBlob(blob);
      setPreviewUrl(URL.createObjectURL(blob));
      setReady(false);
      if (match) setLiveMatch(match);
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
  }

  function confirm() {
    if (!previewBlob) return;
    if (needLiveness && !livenessDone) {
      setError("Live checks are required.");
      return;
    }
    if (requireFaceMatch && (!liveMatch || !liveMatch.ok)) {
      setError(`Face match must be ${FACE_MATCH_REQUIRED_PERCENT}%+ before using this selfie.`);
      return;
    }
    const file = new File([previewBlob], `attendance-selfie-${Date.now()}.jpg`, { type: "image/jpeg" });
    onCapture(file, liveMatch);
  }

  const matchLabel = !livenessDone && needLiveness
    ? livenessHint || (challenge ? livenessPrompt(challenge) : "Live check…")
    : liveMatch
      ? liveMatch.percent > 0 || liveMatch.ok
        ? `Live match ${liveMatch.percent}%${liveMatch.ok ? " · good" : ` · need ${FACE_MATCH_REQUIRED_PERCENT}%+`}`
        : liveMatch.reason || "Looking for face..."
      : modelsLoading
        ? "Loading face model..."
        : requireFaceMatch
          ? "Align face in the circle for live match"
          : "Position your face inside the circle";

  const stepLabel = needLiveness
    ? `Live check ${Math.min(challengeIndex + 1, LIVENESS_CHALLENGES.length)}/${LIVENESS_CHALLENGES.length}`
    : null;

  return (
    <>
      <button aria-label="Close selfie panel" className="dx-sheet-scrim" onClick={onClose} type="button" />
      <aside className="dx-selfie-panel" role="dialog" aria-modal="true" aria-labelledby="selfie-panel-title">
        <header>
          <div>
            <strong id="selfie-panel-title">{title}</strong>
            <small>{hint}</small>
          </div>
          <button aria-label="Close" onClick={onClose} type="button"><X /></button>
        </header>

        <div className="dx-selfie-stage">
          <div className={`dx-selfie-frame ${livenessDone && liveMatch?.ok ? "ok" : liveMatch && liveMatch.percent > 0 ? "warn" : livenessDone ? "ok" : ""}`}>
            {previewUrl ? (
              <img alt="Selfie preview" className="dx-selfie-live" src={previewUrl} />
            ) : (
              <video
                autoPlay
                className="dx-selfie-live"
                muted
                playsInline
                ref={videoRef}
              />
            )}
            <div aria-hidden className="dx-selfie-mask">
              <div className="dx-selfie-circle" />
            </div>
          </div>
          <p className={`dx-selfie-guide ${livenessDone ? "ok" : ""}`}>
            {previewUrl
              ? liveMatch?.ok
                ? `Matched ${liveMatch.percent}% — you can use this selfie`
                : "Check that your face fills the circle clearly."
              : matchLabel}
          </p>
          {needLiveness && !previewUrl ? (
            <div className="dx-selfie-score warn" aria-live="polite">
              <strong>{stepLabel}</strong>
              <span>{Math.round(livenessProgress * 100)}%</span>
            </div>
          ) : null}
          {requireFaceMatch && livenessDone && liveMatch && liveMatch.percent > 0 ? (
            <div className={`dx-selfie-score ${liveMatch.ok ? "ok" : "warn"}`} aria-live="polite">
              <strong>{liveMatch.percent}%</strong>
              <span>{liveMatch.ok ? "match" : `need ${FACE_MATCH_REQUIRED_PERCENT}%+`}</span>
            </div>
          ) : null}
        </div>

        {error ? <p className="dx-form-error">{error}</p> : null}

        <div className="dx-selfie-panel-actions">
          {previewUrl ? (
            <>
              <button className="secondary" onClick={retake} type="button"><RefreshCw /> Retake</button>
              <button
                disabled={requireFaceMatch && !liveMatch?.ok}
                onClick={confirm}
                type="button"
              >
                <Check /> Use selfie
              </button>
            </>
          ) : (
            <>
              <button className="secondary" onClick={onClose} type="button">Cancel</button>
              <button
                disabled={!ready || capturing || checking || modelsLoading || (needLiveness && !livenessDone)}
                onClick={snap}
                type="button"
              >
                <Camera />
                {modelsLoading
                  ? "Loading model..."
                  : needLiveness && !livenessDone
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
