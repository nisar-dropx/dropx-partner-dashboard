"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabase";
import {
  prepareProofFile,
  readProofGps,
} from "@/lib/ops-pulse/proof-media";
import {
  isImageMime,
  isPdfMime,
  isVideoMime,
  proofAcceptAttribute,
  proofKindHint,
  proofPrefersCapture,
  type Evidence,
  type ProofRule,
  type SiChecklist,
  type Task,
} from "@/lib/ops-pulse/si-handover/model";
import styles from "./si-handover.module.css";

type ProofTask = Pick<Task, "id" | "proof"> | { id: string; proof: ProofRule };

const stamp = (v: string | null | undefined) =>
  v
    ? new Date(v).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "short",
        timeStyle: "short",
      }) + " IST"
    : "—";

function MediaPreview({
  proof,
  apiBase,
  fullscreen,
  onClose,
  onFullscreen,
  onExitFullscreen,
}: {
  proof: Evidence;
  apiBase: string;
  fullscreen: boolean;
  onClose: () => void;
  onFullscreen: () => void;
  onExitFullscreen: () => void;
}) {
  const src = `${apiBase}/evidence/${proof.id}`;
  const mime = proof.content_type || "";
  return (
    <div
      className={fullscreen ? styles.mediaFs : styles.mediaModal}
      role="dialog"
      aria-modal="true"
      aria-label={proof.file_name}
      onClick={onClose}
    >
      <div
        className={fullscreen ? styles.mediaFsBody : styles.mediaModalBody}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.mediaHead}>
          <div>
            <strong>{proof.file_name}</strong>
            <small>{stamp(proof.captured_at)}</small>
          </div>
          <div className={styles.mediaActions}>
            {fullscreen ? (
              <button type="button" className={styles.btnTiny} onClick={onExitFullscreen}>
                Exit full screen
              </button>
            ) : (
              <button type="button" className={styles.btnTiny} onClick={onFullscreen}>
                Full screen
              </button>
            )}
            <a className={styles.btnTiny} href={src} target="_blank" rel="noreferrer">
              Open file
            </a>
            <button type="button" className={styles.btnTiny} onClick={onClose}>
              Close
            </button>
          </div>
        </header>
        <div className={styles.mediaStage}>
          {isImageMime(mime) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={proof.file_name} />
          ) : isVideoMime(mime) ? (
            <video src={src} controls playsInline autoPlay={fullscreen} />
          ) : isPdfMime(mime) ? (
            <iframe title={proof.file_name} src={src} />
          ) : (
            <p className={styles.meta}>Preview not available for this file type.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function LiveCameraSheet({
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
          throw new Error("Live camera is not supported here. Use Take or Attach.");
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
    <div className={styles.liveCam} role="dialog" aria-modal="true" aria-label="Live camera">
      <div className={styles.liveCamBody}>
        <header className={styles.liveCamHead}>
          <div className={styles.liveCamTitle}>
            <strong>Live camera</strong>
            <span>Photo stamped with time & GPS after capture</span>
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
              <button type="button" className={styles.liveCamSecondary} onClick={onClose}>
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
              setFacing((prev) => (prev === "environment" ? "user" : "environment"))
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
        {locked ? <p className={styles.liveCamSaving}>Compressing & uploading…</p> : null}
      </div>
    </div>,
    document.body,
  );
}

export function ProofPanel({
  checklist,
  task,
  proofs,
  editable,
  onChange,
  onError,
  apiBase = "/api/ops-pulse/si-handover",
  storeLabel = null,
}: {
  checklist: Pick<SiChecklist, "id">;
  task: ProofTask;
  proofs: Evidence[];
  editable: boolean;
  onChange: (next: Evidence[]) => void;
  onError: (msg: string) => void;
  apiBase?: string;
  storeLabel?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [preview, setPreview] = useState<Evidence | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const uid = useId();
  const mine = proofs.filter((p) => p.task_id === task.id);
  const room = Math.max(0, task.proof.max - mine.length);
  const preferCapture = proofPrefersCapture(task.proof.kind);
  const allowLiveStill =
    task.proof.kind === "live" ||
    task.proof.kind === "photo" ||
    task.proof.kind === "optional" ||
    task.proof.kind === "document";
  const acceptNative =
    task.proof.kind === "video"
      ? "video/*"
      : preferCapture
        ? "image/*"
        : proofAcceptAttribute(task.proof.kind);
  const acceptAttach =
    task.proof.kind === "screenshot"
      ? "image/*"
      : task.proof.kind === "document"
        ? "image/*,application/pdf"
        : task.proof.kind === "video"
          ? "video/mp4,video/webm,video/quicktime"
          : proofAcceptAttribute(task.proof.kind);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (fullscreen) setFullscreen(false);
        else setPreview(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, fullscreen]);

  if (task.proof.kind === "none") return null;

  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, room);
    if (!list.length) return;
    setBusy(true);
    setStatus("Preparing…");
    onError("");
    try {
      setStatus("Getting location…");
      const gps = await readProofGps(4500);
      let next = [...proofs];
      let index = 0;
      for (const raw of list) {
        index += 1;
        setStatus(
          list.length > 1
            ? `Processing ${index}/${list.length}…`
            : "Compressing & stamping…",
        );
        const capturedAt = new Date().toISOString();
        if (!Number.isFinite(Date.parse(capturedAt))) {
          throw Error("Could not read capture time on this device.");
        }
        const file = await prepareProofFile(raw, {
          capturedAt,
          latitude: gps.latitude,
          longitude: gps.longitude,
          accuracyM: gps.accuracyM,
          storeLabel,
        });
        const contentType = (file.type || raw.type || "image/jpeg").toLowerCase();
        const size = Math.max(0, Math.round(Number(file.size) || 0));
        if (size < 1) throw Error("Captured file was empty. Try again.");
        setStatus(list.length > 1 ? `Uploading ${index}/${list.length}…` : "Uploading…");
        const prep = await fetch(`${apiBase}/upload`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            phase: "prepare",
            checklistId: checklist.id,
            taskId: task.id,
            fileName: file.name || `proof-${Date.now()}.jpg`,
            size,
            contentType,
            capturedAt,
            latitude: gps.latitude,
            longitude: gps.longitude,
          }),
        });
        let prepared: {
          error?: string;
          id?: string;
          path?: string;
          token?: string;
        } = {};
        try {
          prepared = await prep.json();
        } catch {
          throw Error(prep.ok ? "Prepare failed." : `Prepare failed (${prep.status}).`);
        }
        if (!prep.ok) throw Error(prepared.error || "Prepare failed.");
        if (!prepared.id || !prepared.path || !prepared.token) {
          throw Error("Upload prepare response was incomplete.");
        }
        if (!supabase) throw Error("Upload client unavailable. Refresh and try again.");
        const up = await supabase.storage
          .from("ops-pulse-documents")
          .uploadToSignedUrl(prepared.path, prepared.token, file, {
            contentType,
            upsert: false,
          });
        if (up.error) throw Error(up.error.message || "Storage upload failed.");
        const done = await fetch(`${apiBase}/upload`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            phase: "complete",
            checklistId: checklist.id,
            taskId: task.id,
            id: prepared.id,
          }),
        });
        let body: { error?: string; proof?: Evidence } = {};
        try {
          body = await done.json();
        } catch {
          throw Error(done.ok ? "Confirm failed." : `Confirm failed (${done.status}).`);
        }
        if (!done.ok) throw Error(body.error || "Confirm failed.");
        if (!body.proof?.id) throw Error("Upload confirmed but proof was missing.");
        next = [...next, body.proof];
        onChange(next);
      }
      setStatus("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Upload failed.");
      setStatus("");
      throw err;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.proofs}>
      <div className={styles.proofMeta}>
        <span>{proofKindHint(task.proof.kind)}</span>
        <span>
          {mine.length}/{task.proof.max}
          {task.proof.min ? ` · min ${task.proof.min}` : ""}
        </span>
      </div>
      {status ? <small className={styles.proofStatus}>{status}</small> : null}
      <div className={styles.proofGrid}>
        {mine.map((p) => (
          <div key={p.id} className={styles.proofThumb}>
            <button
              type="button"
              className={styles.proofThumbBtn}
              onClick={() => {
                setFullscreen(false);
                setPreview(p);
              }}
              title={p.file_name}
            >
              {isImageMime(p.content_type) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`${apiBase}/evidence/${p.id}`} alt="" />
              ) : isVideoMime(p.content_type) ? (
                <span className={styles.proofBadge}>Video</span>
              ) : isPdfMime(p.content_type) ? (
                <span className={styles.proofBadge}>PDF</span>
              ) : (
                <span className={styles.proofBadge}>File</span>
              )}
            </button>
            <small>{stamp(p.captured_at)}</small>
            {editable ? (
              <button
                type="button"
                className={styles.linkDanger}
                disabled={busy}
                onClick={async () => {
                  const r = await fetch(`${apiBase}/upload`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      phase: "delete",
                      checklistId: checklist.id,
                      taskId: task.id,
                      id: p.id,
                    }),
                  });
                  const j = await r.json();
                  if (!r.ok) return onError(j.error || "Could not remove proof.");
                  onChange(proofs.filter((x) => x.id !== p.id));
                  if (preview?.id === p.id) setPreview(null);
                }}
              >
                Remove
              </button>
            ) : null}
          </div>
        ))}
        {editable && room > 0 ? (
          <>
            {preferCapture ? (
              <>
                <label
                  className={`${styles.proofAdd}${busy ? ` ${styles.proofAddBusy}` : ""}`}
                  htmlFor={`${uid}-cam`}
                >
                  {busy ? "…" : task.proof.kind === "video" ? "Record" : "Take"}
                  <input
                    id={`${uid}-cam`}
                    className={styles.proofFileInput}
                    type="file"
                    accept={acceptNative}
                    capture="environment"
                    disabled={busy}
                    onChange={(e) => {
                      const files = e.target.files;
                      e.target.value = "";
                      if (files?.length) void uploadFiles(files).catch(() => undefined);
                    }}
                  />
                </label>
                {allowLiveStill ? (
                  <button
                    type="button"
                    className={`${styles.proofAdd}${busy ? ` ${styles.proofAddBusy}` : ""}`}
                    disabled={busy}
                    onClick={() => setLiveOpen(true)}
                  >
                    Live
                  </button>
                ) : null}
              </>
            ) : null}
            <label
              className={`${styles.proofAdd}${busy ? ` ${styles.proofAddBusy}` : ""}`}
              htmlFor={`${uid}-files`}
            >
              {busy ? "…" : preferCapture ? "Attach" : room > 1 ? "Add" : "Add"}
              <input
                id={`${uid}-files`}
                className={styles.proofFileInput}
                type="file"
                accept={acceptAttach}
                multiple={room > 1 && !preferCapture}
                disabled={busy}
                onChange={(e) => {
                  const files = e.target.files;
                  e.target.value = "";
                  if (files?.length) void uploadFiles(files).catch(() => undefined);
                }}
              />
            </label>
          </>
        ) : null}
      </div>
      {liveOpen ? (
        <LiveCameraSheet
          busy={busy}
          onClose={() => setLiveOpen(false)}
          onCapture={async (file) => {
            await uploadFiles([file]); // throws on failure so sheet stays open
          }}
        />
      ) : null}
      {preview ? (
        <MediaPreview
          proof={preview}
          apiBase={apiBase}
          fullscreen={fullscreen}
          onClose={() => {
            setPreview(null);
            setFullscreen(false);
          }}
          onFullscreen={() => setFullscreen(true)}
          onExitFullscreen={() => setFullscreen(false)}
        />
      ) : null}
    </div>
  );
}
