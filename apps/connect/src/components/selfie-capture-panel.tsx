"use client";

import { Camera, Check, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  FACE_MATCH_REQUIRED_PERCENT,
  ensureFaceModels,
  matchLiveFrameToProfile,
  type FaceMatchResult
} from "@/lib/face-match";

type SelfieCapturePanelProps = {
  title?: string;
  hint?: string;
  profilePhotoUrl?: string | null;
  /** When true, Use selfie stays disabled until face match >= required %. */
  requireFaceMatch?: boolean;
  onCapture: (file: File, match: FaceMatchResult | null) => void;
  onClose: () => void;
};

export function SelfieCapturePanel({
  title = "Face verification",
  hint = "Center your face inside the circle. Keep good lighting and look straight at the camera.",
  profilePhotoUrl,
  requireFaceMatch = false,
  onCapture,
  onClose
}: SelfieCapturePanelProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(Boolean(requireFaceMatch && profilePhotoUrl));
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [liveMatch, setLiveMatch] = useState<FaceMatchResult | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!requireFaceMatch || !profilePhotoUrl) {
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

  // Live match while camera is open (before capture).
  useEffect(() => {
    if (!requireFaceMatch || !profilePhotoUrl || !ready || previewUrl || modelsLoading) return;
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
    }, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [requireFaceMatch, profilePhotoUrl, ready, previewUrl, modelsLoading]);

  async function snap() {
    const video = videoRef.current;
    if (!video || !ready || capturing) return;
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
          // Keep camera running so they can adjust and capture again.
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
  }

  function confirm() {
    if (!previewBlob) return;
    if (requireFaceMatch && (!liveMatch || !liveMatch.ok)) {
      setError(`Face match must be ${FACE_MATCH_REQUIRED_PERCENT}%+ before using this selfie.`);
      return;
    }
    const file = new File([previewBlob], `attendance-selfie-${Date.now()}.jpg`, { type: "image/jpeg" });
    onCapture(file, liveMatch);
  }

  const matchLabel = liveMatch
    ? liveMatch.percent > 0 || liveMatch.ok
      ? `Live match ${liveMatch.percent}%${liveMatch.ok ? " · good" : ` · need ${FACE_MATCH_REQUIRED_PERCENT}%+`}`
      : liveMatch.reason || "Looking for face..."
    : modelsLoading
      ? "Loading face model..."
      : requireFaceMatch
        ? "Align face in the circle for live match"
        : "Position your face inside the circle";

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
          <div className={`dx-selfie-frame ${liveMatch?.ok ? "ok" : liveMatch && liveMatch.percent > 0 ? "warn" : ""}`}>
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
          <p className={`dx-selfie-guide ${liveMatch?.ok ? "ok" : ""}`}>
            {previewUrl
              ? liveMatch?.ok
                ? `Matched ${liveMatch.percent}% — you can use this selfie`
                : "Check that your face fills the circle clearly."
              : matchLabel}
          </p>
          {requireFaceMatch && liveMatch && liveMatch.percent > 0 ? (
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
              <button disabled={!ready || capturing || checking || modelsLoading} onClick={snap} type="button">
                <Camera />
                {modelsLoading
                  ? "Loading model..."
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
