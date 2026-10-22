"use client";

import { useEffect, useId, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
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

async function readGps(): Promise<{
  latitude: number | null;
  longitude: number | null;
}> {
  if (typeof navigator === "undefined" || !navigator.geolocation)
    return { latitude: null, longitude: null };
  try {
    const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 60000,
      }),
    );
    return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
  } catch {
    return { latitude: null, longitude: null };
  }
}

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

export function ProofPanel({
  checklist,
  task,
  proofs,
  editable,
  onChange,
  onError,
  apiBase = "/api/ops-pulse/si-handover",
}: {
  checklist: Pick<SiChecklist, "id">;
  task: ProofTask;
  proofs: Evidence[];
  editable: boolean;
  onChange: (next: Evidence[]) => void;
  onError: (msg: string) => void;
  apiBase?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Evidence | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const mine = proofs.filter((p) => p.task_id === task.id);
  const room = Math.max(0, task.proof.max - mine.length);
  const preferCapture = proofPrefersCapture(task.proof.kind);
  const accept = proofAcceptAttribute(task.proof.kind);

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
    try {
      const gps = await readGps();
      let next = [...proofs];
      for (const file of list) {
        const capturedAt = new Date().toISOString();
        const prep = await fetch(`${apiBase}/upload`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            phase: "prepare",
            checklistId: checklist.id,
            taskId: task.id,
            fileName: file.name,
            size: file.size,
            contentType: file.type || "image/jpeg",
            capturedAt,
            latitude: gps.latitude,
            longitude: gps.longitude,
          }),
        });
        const prepared = await prep.json();
        if (!prep.ok) throw Error(prepared.error || "Prepare failed.");
        if (!supabase) throw Error("Upload client unavailable.");
        const up = await supabase.storage
          .from("ops-pulse-documents")
          .uploadToSignedUrl(prepared.path, prepared.token, file);
        if (up.error) throw Error(up.error.message);
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
        const body = await done.json();
        if (!done.ok) throw Error(body.error || "Confirm failed.");
        next = [...next, body.proof as Evidence];
        onChange(next);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Upload failed.");
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
              <button
                type="button"
                className={`${styles.proofAdd}${busy ? ` ${styles.proofAddBusy}` : ""}`}
                disabled={busy}
                onClick={() => cameraRef.current?.click()}
              >
                {busy ? "…" : "Camera"}
              </button>
            ) : null}
            <button
              type="button"
              className={`${styles.proofAdd}${busy ? ` ${styles.proofAddBusy}` : ""}`}
              disabled={busy}
              onClick={() => filesRef.current?.click()}
            >
              {busy
                ? "…"
                : preferCapture
                  ? room > 1
                    ? "Files"
                    : "File"
                  : room > 1
                    ? "Add files"
                    : "Add"}
            </button>
            {preferCapture ? (
              <input
                id={`${uid}-cam`}
                ref={cameraRef}
                type="file"
                accept={accept}
                capture="environment"
                hidden
                disabled={busy}
                onChange={async (e) => {
                  const files = e.target.files;
                  e.target.value = "";
                  if (files?.length) await uploadFiles(files);
                }}
              />
            ) : null}
            <input
              id={`${uid}-files`}
              ref={filesRef}
              type="file"
              accept={accept}
              multiple={room > 1}
              hidden
              disabled={busy}
              onChange={async (e) => {
                const files = e.target.files;
                e.target.value = "";
                if (files?.length) await uploadFiles(files);
              }}
            />
          </>
        ) : null}
      </div>
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
