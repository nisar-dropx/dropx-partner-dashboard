"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./ops-live-camera.module.css";

/** Full-screen live camera used by SI handover and store audits. */
export function OpsLiveCamera({
  onCapture,
  onClose,
  busy,
}: {
  onCapture: (file: File) => void | Promise<void>;
  onClose: () => void;
  busy: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [mounted, setMounted] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [flash, setFlash] = useState(false);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [clock, setClock] = useState(() =>
    new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }),
  );

  useEffect(() => {
    setMounted(true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      setClock(
        new Date().toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          day: "2-digit",
          month: "short",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
          hour12: true,
        }),
      );
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !capturing && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, capturing, onClose]);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      setError("");
      setReady(false);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(
            "Live camera is not supported here. Use Take or Attach.",
          );
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
          if (!cancelled) setReady(true);
        }
      } catch (reason) {
        if (!cancelled) {
          const msg =
            reason instanceof Error
              ? reason.name === "NotAllowedError"
                ? "Camera permission denied. Allow camera, or use Take / Attach."
                : reason.name === "NotFoundError"
                  ? "No camera found on this device."
                  : reason.message
              : "Unable to open live camera.";
          setError(msg);
        }
      }
    }
    start().catch(() => undefined);
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [facing]);

  const snap = async () => {
    const video = videoRef.current;
    if (!video || !ready || capturing || busy) return;
    setCapturing(true);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 160);
    try {
      const w = video.videoWidth || 1280;
      const h = video.videoHeight || 720;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Unable to capture frame.");
      if (facing === "user") {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0, w, h);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Capture failed."))),
          "image/jpeg",
          0.92,
        ),
      );
      const file = new File([blob], `live-${Date.now()}.jpg`, {
        type: "image/jpeg",
        lastModified: Date.now(),
      });
      await onCapture(file);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Capture failed.");
    } finally {
      setCapturing(false);
    }
  };

  if (!mounted) return null;
  const locked = capturing || busy;
  return createPortal(
    <div
      className={styles.liveCam}
      role="dialog"
      aria-modal="true"
      aria-label="Live camera"
    >
      <div className={styles.liveCamBody}>
        <header className={styles.liveCamHead}>
          <div className={styles.liveCamTitle}>
            <strong>Live camera</strong>
            <span>Photo stamped with time &amp; GPS after capture</span>
          </div>
          <button
            type="button"
            className={styles.liveCamClose}
            onClick={onClose}
            disabled={locked}
            aria-label="Close camera"
          >
            ✕
          </button>
        </header>

        <div className={styles.liveCamStage}>
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className={`${styles.liveCamVideo}${facing === "user" ? ` ${styles.liveCamMirror}` : ""}`}
          />
          {flash ? <span className={styles.liveCamFlash} aria-hidden /> : null}
          {!ready && !error ? (
            <span className={styles.liveCamWait}>Opening camera…</span>
          ) : null}
          {error ? (
            <div className={styles.liveCamError}>
              <strong>Camera unavailable</strong>
              <p>{error}</p>
              <button
                type="button"
                className={styles.liveCamSecondary}
                onClick={onClose}
              >
                Use Take or Attach instead
              </button>
            </div>
          ) : null}
          {ready && !error ? (
            <div className={styles.liveCamStamp}>
              <span>{clock} IST</span>
              <small>Will stamp on save</small>
            </div>
          ) : null}
        </div>

        <div className={styles.liveCamActions}>
          <button
            type="button"
            className={styles.liveCamSecondary}
            disabled={locked || Boolean(error)}
            onClick={() =>
              setFacing((prev) =>
                prev === "environment" ? "user" : "environment",
              )
            }
          >
            Flip
          </button>
          <button
            type="button"
            className={styles.liveCamShutter}
            disabled={!ready || locked || Boolean(error)}
            onClick={() => void snap()}
            aria-label={locked ? "Saving photo" : "Capture photo"}
          >
            <span className={styles.liveCamShutterRing} />
            <span className={styles.liveCamShutterCore} />
          </button>
          <button
            type="button"
            className={styles.liveCamSecondary}
            disabled={locked}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
        {locked ? (
          <p className={styles.liveCamSaving}>Compressing &amp; uploading…</p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
