"use client";

import { Camera, Check, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type SelfieCapturePanelProps = {
  title?: string;
  hint?: string;
  onCapture: (file: File) => void;
  onClose: () => void;
};

export function SelfieCapturePanel({
  title = "Face verification",
  hint = "Center your face inside the circle. Keep good lighting and look straight at the camera.",
  onCapture,
  onClose
}: SelfieCapturePanelProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      setError("");
      setReady(false);
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
              ? reason.message.includes("Permission") || reason.name === "NotAllowedError"
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

  async function snap() {
    const video = videoRef.current;
    if (!video || !ready || capturing) return;
    setCapturing(true);
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
      // Mirror to match what the user sees in the preview.
      ctx.translate(size, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, sx, sy, size, size, 0, 0, size, size);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
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
      setCapturing(false);
    }
  }

  function retake() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl("");
    setPreviewBlob(null);
    setError("");
  }

  function confirm() {
    if (!previewBlob) return;
    const file = new File([previewBlob], `attendance-selfie-${Date.now()}.jpg`, { type: "image/jpeg" });
    onCapture(file);
  }

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
          <div className="dx-selfie-frame">
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
          <p className="dx-selfie-guide">
            {previewUrl ? "Check that your face fills the circle clearly." : "Position your face inside the circle"}
          </p>
        </div>

        {error ? <p className="dx-form-error">{error}</p> : null}

        <div className="dx-selfie-panel-actions">
          {previewUrl ? (
            <>
              <button className="secondary" onClick={retake} type="button"><RefreshCw /> Retake</button>
              <button onClick={confirm} type="button"><Check /> Use selfie</button>
            </>
          ) : (
            <>
              <button className="secondary" onClick={onClose} type="button">Cancel</button>
              <button disabled={!ready || capturing} onClick={snap} type="button">
                <Camera /> {capturing ? "Capturing..." : ready ? "Capture" : "Starting camera..."}
              </button>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
