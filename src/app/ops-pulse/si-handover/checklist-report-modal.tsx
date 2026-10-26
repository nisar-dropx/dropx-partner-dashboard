"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { lockBodyScroll } from "@/lib/body-scroll-lock";
import {
  buildChecklistReportPdf,
  downloadPdfBytes,
} from "@/lib/ops-pulse/build-checklist-report-pdf";
import {
  formatTaskAnswer,
  isImageProof,
  isPdfProof,
  isVideoProof,
  type ReportPack,
  type ReportPackProof,
} from "@/lib/ops-pulse/checklist-report-pack";
import { renderPdfPages } from "@/lib/ops-pulse/pdf-slip";
import styles from "./si-handover.module.css";
import { ChecklistSummaryActions } from "./checklist-summary-actions";

type Props = {
  kind: "shift" | "store";
  checklistId: string | null;
  onClose: () => void;
};

function proofKind(p: ReportPackProof) {
  if (isVideoProof(p.content_type, p.file_name)) return "video";
  if (isPdfProof(p.content_type, p.file_name)) return "pdf";
  if (isImageProof(p.content_type, p.file_name)) return "image";
  return "other";
}

function safeFileBase(raw: string) {
  return raw.replace(/[^\w.\-]+/g, "-").replace(/-+/g, "-").slice(0, 80) || "checklist";
}

function PdfThumb({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) throw Error("fail");
        const rendered = await renderPdfPages(await res.arrayBuffer(), {
          maxPages: 1,
          width: 480,
          quality: 0.75,
        });
        if (cancelled || !rendered.pages[0]) {
          if (!cancelled) setErr(true);
          return;
        }
        objectUrl = URL.createObjectURL(rendered.pages[0].blob);
        setSrc(objectUrl);
      } catch {
        if (!cancelled) setErr(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);
  if (err) {
    return (
      <span className={styles.reportProofFallback}>
        PDF preview unavailable ·{" "}
        <a href={url} target="_blank" rel="noreferrer">
          open original
        </a>
      </span>
    );
  }
  if (!src) {
    return <span className={styles.reportProofFallback}>Loading PDF…</span>;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className={styles.reportProofImg} src={src} alt="PDF proof preview" />
  );
}

function ImageProof({ url, alt }: { url: string; alt: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span className={styles.reportProofFallback}>
        Could not preview ·{" "}
        <a href={url} target="_blank" rel="noreferrer">
          open original
        </a>
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={styles.reportProofImg}
      src={url}
      alt={alt}
      onError={() => setBroken(true)}
    />
  );
}

export function ChecklistReportModal({ kind, checklistId, onClose }: Props) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [pack, setPack] = useState<ReportPack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!checklistId) {
      setPack(null);
      setError(null);
      setLoading(false);
      setDownloading(false);
      return;
    }
    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    setPack(null);
    const path =
      kind === "shift"
        ? `/api/ops-pulse/si-handover/report-pack?id=${encodeURIComponent(checklistId)}`
        : `/api/ops-pulse/store-ops/report-pack?id=${encodeURIComponent(checklistId)}`;
    fetch(path, { credentials: "same-origin", signal: ac.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw Error(body.error || "Unable to load report.");
        return body as ReportPack;
      })
      .then((data) => {
        if (!ac.signal.aborted) setPack(data);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Unable to load report.");
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [checklistId, kind]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!checklistId) return;
    const unlock = lockBodyScroll();
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.fullscreenElement) {
          void document.exitFullscreen();
          return;
        }
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unlock();
      window.removeEventListener("keydown", onKey);
    };
  }, [checklistId]);

  const toggleFullscreen = useCallback(async () => {
    const el = dialogRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) {
        await el.requestFullscreen();
        setFullscreen(true);
      } else {
        await document.exitFullscreen();
        setFullscreen(false);
      }
    } catch {
      setFullscreen((v) => !v);
    }
  }, []);

  useEffect(() => {
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const onDownload = async () => {
    if (!pack || downloading) return;
    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;
    setDownloading(true);
    setError(null);
    try {
      const bytes = await buildChecklistReportPdf(pack, { signal: ac.signal });
      const base =
        pack.kind === "shift"
          ? `${pack.checklist.store_code}-${pack.checklist.shift_date || "shift"}-${pack.checklist.shift_slot || "slot"}`
          : `${pack.checklist.store_code}-${pack.checklist.work_date || "day"}`;
      downloadPdfBytes(bytes, `ops-checklist-${safeFileBase(base)}.pdf`);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "PDF download failed.");
    } finally {
      setDownloading(false);
    }
  };

  if (!checklistId) return null;

  const c = pack?.checklist;
  const when = c
    ? pack?.kind === "shift"
      ? `${c.shift_date || ""} ${c.shift_slot || ""}`.trim()
      : c.work_date || ""
    : "";
  const answeredTasks =
    pack?.sections.reduce(
      (n, section) =>
        n +
        section.tasks.filter((t) => formatTaskAnswer(t) !== "—").length,
      0,
    ) || 0;

  return (
    <div
      className={styles.reportModalBackdrop}
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`${styles.reportModal} ${fullscreen ? styles.reportModalFs : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.reportModalHead}>
          <div>
            <p className={styles.eyebrow}>
              {kind === "shift"
                ? "Shift checklist report"
                : "Store checklist report"}
            </p>
            <h2 id={titleId} className={styles.reportModalTitle}>
              {c ? `${c.store_code} · ${when}` : "Loading report…"}
            </h2>
            {c ? (
              <p className={styles.reportModalMeta}>
                {c.person_name}
                {c.incoming_name ? ` → ${c.incoming_name}` : ""} · {c.statusLabel}{" "}
                · {c.pct}% ({c.answered}/{c.total})
              </p>
            ) : null}
          </div>
          <div className={styles.reportModalActions}>
            {pack?.editUrl ? (
              <Link
                prefetch={false}
                className={styles.btnTiny}
                href={pack.editUrl}
              >
                Edit checklist
              </Link>
            ) : null}
            <button
              type="button"
              className={styles.btnTiny}
              onClick={toggleFullscreen}
            >
              {fullscreen ? "Exit fullscreen" : "Fullscreen"}
            </button>
            <button
              type="button"
              className={styles.btnAccent}
              disabled={!pack || downloading || loading}
              onClick={() => void onDownload()}
            >
              {downloading ? "Building PDF…" : "PDF with evidence"}
            </button>
            <button
              ref={closeRef}
              type="button"
              className={styles.lineAdd}
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </header>

        <div className={styles.reportModalBody}>
          {pack ? <ChecklistSummaryActions kind={pack.kind} id={pack.checklist.id} pack={pack} completed={["submitted", "accepted"].includes(pack.checklist.status)} /> : null}
          {pack?.checklist ? (
            <div className={styles.reportModalSummary} aria-label="Report summary">
              <span><strong>{c?.pct ?? 0}%</strong><small>completion</small></span>
              <span><strong>{c?.answered ?? 0}/{c?.total ?? 0}</strong><small>required answers</small></span>
              <span><strong>{pack.proofs.length}</strong><small>evidence files</small></span>
              <span><strong>{pack.sections.length}</strong><small>sections</small></span>
            </div>
          ) : null}
          {loading ? (
            <div className={styles.reportModalSkeleton} aria-busy="true">
              <div />
              <div />
              <div />
            </div>
          ) : null}
          {error ? <p className={styles.errorText}>{error}</p> : null}
          {!loading && !error && pack && !pack.sections.length ? (
            <p className={styles.muted}>
              This checklist has no template sections to show.
            </p>
          ) : null}
          {!loading && pack && pack.sections.length && answeredTasks === 0 ? (
            <p className={styles.muted}>
              No answers yet — open Edit checklist to fill tasks, or download a
              blank shell PDF.
            </p>
          ) : null}
          {pack
            ? pack.sections.map((section) => (
                <section key={section.id} className={styles.reportPdfSection}>
                  <h3>{section.name || "Section"}</h3>
                  {!section.tasks.length ? (
                    <p className={styles.muted}>No tasks in this section.</p>
                  ) : (
                    section.tasks.map((task, taskIndex) => {
                      const proofs = pack.proofs.filter(
                        (p) => p.task_id === task.id,
                      );
                      return (
                        <div key={task.id} className={styles.reportPdfTask}>
                          <div className={styles.reportPdfTaskTop}>
                            <span className={styles.reportTaskNumber}>{String(taskIndex + 1).padStart(2, "0")}</span>
                            <strong>{task.label || task.id}</strong>
                            <span className={styles.reportAnswer}>{formatTaskAnswer(task)}</span>
                          </div>
                          {proofs.length ? (
                            <div className={styles.reportProofGrid}>
                              {proofs.map((p) => {
                                const k = proofKind(p);
                                if (k === "video") {
                                  return (
                                    <a
                                      key={p.id}
                                      className={styles.reportVideoLink}
                                      href={p.url}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      View video · {p.file_name || "clip"}
                                    </a>
                                  );
                                }
                                if (k === "pdf") {
                                  return (
                                    <div
                                      key={p.id}
                                      className={styles.reportProofCell}
                                    >
                                      <PdfThumb url={p.url} />
                                      <a
                                        href={p.url}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        Open PDF
                                      </a>
                                    </div>
                                  );
                                }
                                if (k === "image") {
                                  return (
                                    <div
                                      key={p.id}
                                      className={styles.reportProofCell}
                                    >
                                      <ImageProof
                                        url={p.url}
                                        alt={p.file_name || "Proof"}
                                      />
                                    </div>
                                  );
                                }
                                return (
                                  <a
                                    key={p.id}
                                    className={styles.reportVideoLink}
                                    href={p.url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Open {p.file_name || "file"}
                                  </a>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </section>
              ))
            : null}
        </div>
      </div>
    </div>
  );
}
