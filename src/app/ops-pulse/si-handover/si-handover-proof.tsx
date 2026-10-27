"use client";
import { useOpsScreenRequest, useOpsScreenRuntime } from "@/components/ops-screen-runtime";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { OpsLiveCamera } from "@/components/ops-live-camera";
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
  const runtime = useOpsScreenRuntime();
  const src = runtime ? runtime.mediaUrl(proof.id) : `${apiBase}/evidence/${proof.id}`;
  const mime = proof.content_type || "";
  const [mounted, setMounted] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    setMounted(true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (fullscreen) onExitFullscreen();
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, onClose, onExitFullscreen]);

  if (!mounted) return null;
  return createPortal(
    <div
      className={fullscreen ? styles.mediaFs : styles.mediaModal}
      role="dialog"
      aria-modal="true"
      aria-label={proof.file_name || "Proof preview"}
      onClick={onClose}
    >
      <div
        className={fullscreen ? styles.mediaFsBody : styles.mediaModalBody}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.mediaHead}>
          <div className={styles.mediaHeadText}>
            <strong>{proof.file_name || "Proof"}</strong>
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
              Open
            </a>
            <button
              type="button"
              className={styles.mediaClose}
              onClick={onClose}
              aria-label="Close preview"
            >
              ✕
            </button>
          </div>
        </header>
        <div className={styles.mediaStage}>
          {loadError ? (
            <div className={styles.mediaFallback}>
              <p>Preview could not load.</p>
              <a className={styles.btnAccent} href={src} target="_blank" rel="noreferrer">
                Open file
              </a>
            </div>
          ) : isImageMime(mime) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={proof.file_name || "Proof"}
              onError={() => setLoadError(true)}
            />
          ) : isVideoMime(mime) ? (
            <video
              src={src}
              controls
              playsInline
              autoPlay
              onError={() => setLoadError(true)}
            />
          ) : isPdfMime(mime) ? (
            <iframe title={proof.file_name || "PDF"} src={src} />
          ) : (
            <div className={styles.mediaFallback}>
              <p>Preview not available for this file type.</p>
              <a className={styles.btnAccent} href={src} target="_blank" rel="noreferrer">
                Open file
              </a>
            </div>
          )}
        </div>
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
  const request = useOpsScreenRequest();
  const demo = useOpsScreenRuntime();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [preview, setPreview] = useState<Evidence | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const camInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  if (task.proof.kind === "none") return null;

  const openPreview = (proof: Evidence) => {
    setFullscreen(false);
    setPreview(proof);
  };

  /** Copy FileList before clearing the input — FileList is live and becomes empty if value is reset first. */
  const pickFromInput = (input: HTMLInputElement | null) => {
    if (!input?.files?.length) return;
    const files = Array.from(input.files);
    input.value = "";
    void uploadFiles(files).catch(() => undefined);
  };

  const addSample = async () => {
    if (!demo || !room) return;
    const res = await demo.request(`${apiBase}/sample-proof`, {method:"POST", body:JSON.stringify({checklistId:checklist.id,taskId:task.id})});
    const body = await res.json();
    if (res.ok) { onChange([...proofs, body.proof]); setStatus("Sample evidence added · no upload or camera access."); }
    else onError(body.error);
  };
  const uploadFiles = async (files: FileList | File[]) => {
    if (demo) { await addSample(); return; }
    const list = Array.from(files).slice(0, room);
    if (!list.length) {
      onError("No file was selected. Try Take, Live, or Attach again.");
      return;
    }
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
        const preparedFile = await prepareProofFile(raw, {
          capturedAt,
          latitude: gps.latitude,
          longitude: gps.longitude,
          accuracyM: gps.accuracyM,
          storeLabel,
        });
        // Gallery picks sometimes omit MIME; infer from name before prepare rejects.
        const inferred =
          preparedFile.type ||
          raw.type ||
          (/\.png$/i.test(preparedFile.name || raw.name) ? "image/png" : "") ||
          (/\.webp$/i.test(preparedFile.name || raw.name) ? "image/webp" : "") ||
          (/\.pdf$/i.test(preparedFile.name || raw.name) ? "application/pdf" : "") ||
          (/\.(mp4|m4v)$/i.test(preparedFile.name || raw.name) ? "video/mp4" : "") ||
          (/\.mov$/i.test(preparedFile.name || raw.name) ? "video/quicktime" : "") ||
          "image/jpeg";
        const contentType = inferred.toLowerCase();
        const file =
          preparedFile.type === contentType
            ? preparedFile
            : new File([preparedFile], preparedFile.name || raw.name || `proof-${Date.now()}.jpg`, {
                type: contentType,
                lastModified: preparedFile.lastModified || Date.now(),
              });
        const size = Math.max(0, Math.round(Number(file.size) || 0));
        if (size < 1) throw Error("Captured file was empty. Try again.");
        setStatus(list.length > 1 ? `Uploading ${index}/${list.length}…` : "Uploading…");
        const prep = await request(`${apiBase}/upload`, {
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
        const { supabase } = await import("@/lib/supabase");
        if (!supabase) throw Error("Upload client unavailable. Refresh and try again.");
        const up = await supabase.storage
          .from("ops-pulse-documents")
          .uploadToSignedUrl(prepared.path, prepared.token, file, {
            contentType,
            upsert: false,
          });
        if (up.error) throw Error(up.error.message || "Storage upload failed.");
        const done = await request(`${apiBase}/upload`, {
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
        const proof = {
          ...body.proof,
          ready: true,
          checklist_id: body.proof.checklist_id || checklist.id,
        } as Evidence;
        next = [...next, proof];
        onChange(next);
        // Show the just-uploaded proof so the SI can confirm stamp / content.
        openPreview(proof);
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
              onClick={() => openPreview(p)}
              title={`Preview ${p.file_name || "proof"}`}
              aria-label={`Preview ${p.file_name || "proof"}`}
            >
              {isImageMime(p.content_type) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={demo ? demo.mediaUrl(p.id) : `${apiBase}/evidence/${p.id}`} alt="" />
              ) : isVideoMime(p.content_type) ? (
                <span className={styles.proofBadge}>Video</span>
              ) : isPdfMime(p.content_type) ? (
                <span className={styles.proofBadge}>PDF</span>
              ) : (
                <span className={styles.proofBadge}>File</span>
              )}
              <span className={styles.proofThumbHint}>View</span>
            </button>
            <small>{stamp(p.captured_at)}</small>
            {editable ? (
              <button
                type="button"
                className={styles.linkDanger}
                disabled={busy}
                onClick={async () => {
                  const r = await request(`${apiBase}/upload`, {
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
                <input
                  ref={camInputRef}
                  className={styles.proofFileInput}
                  type="file"
                  accept={acceptNative}
                  capture="environment"
                  disabled={busy}
                  onChange={() => pickFromInput(camInputRef.current)}
                />
                <button
                  type="button"
                  className={`${styles.proofAdd}${busy ? ` ${styles.proofAddBusy}` : ""}`}
                  disabled={busy}
                  onClick={() => demo ? void addSample() : camInputRef.current?.click()}
                >
                  {busy ? "…" : task.proof.kind === "video" ? "Record" : "Take"}
                </button>
                {allowLiveStill ? (
                  <button
                    type="button"
                    className={`${styles.proofAdd}${busy ? ` ${styles.proofAddBusy}` : ""}`}
                    disabled={busy}
                    onClick={() => demo ? void addSample() : setLiveOpen(true)}
                  >
                    Live
                  </button>
                ) : null}
              </>
            ) : null}
            <input
              ref={fileInputRef}
              className={styles.proofFileInput}
              type="file"
              accept={acceptAttach}
              multiple={room > 1 && !preferCapture}
              disabled={busy}
              onChange={() => pickFromInput(fileInputRef.current)}
            />
            <button
              type="button"
              className={`${styles.proofAdd}${busy ? ` ${styles.proofAddBusy}` : ""}`}
              disabled={busy}
              onClick={() => demo ? void addSample() : fileInputRef.current?.click()}
            >
              {busy ? "…" : preferCapture ? "Attach" : "Add"}
            </button>
          </>
        ) : null}
      </div>
      {liveOpen ? (
        <OpsLiveCamera
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
