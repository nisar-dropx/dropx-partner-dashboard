"use client";

import { Download, ExternalLink, X } from "lucide-react";
import { useEffect, useState, useTransition, type ReactNode } from "react";

export type ConnectAttachmentFile = { label: string; url: string; fileName?: string };

function fileNameFromUrl(url: string, fallback: string) {
  try {
    const path = new URL(url).pathname;
    const name = path.split("/").pop();
    return name ? decodeURIComponent(name) : fallback;
  } catch {
    return fallback;
  }
}

async function downloadAttachment(url: string, fileName: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Unable to download attachment.");
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

/**
 * Opens a signed proof/attachment image in an in-app modal instead of a new
 * browser tab, mirroring the People (HRMS) ApprovalAttachmentViewer.
 */
export function ConnectAttachmentViewer({
  files,
  title = "Attachment",
  trigger
}: {
  files: ConnectAttachmentFile[];
  title?: string;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isDownloading, startDownload] = useTransition();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!files.length) return null;
  const current = files[active] ?? files[0];
  const downloadName = current.fileName || fileNameFromUrl(current.url, `${current.label.replace(/\s+/g, "-").toLowerCase()}.jpg`);

  function onDownload() {
    setDownloadError(null);
    startDownload(async () => {
      try { await downloadAttachment(current.url, downloadName); }
      catch (err) { setDownloadError(err instanceof Error ? err.message : "Unable to download attachment."); }
    });
  }

  return (
    <>
      <button className="dx-attachment-trigger" onClick={() => { setOpen(true); setActive(0); setDownloadError(null); }} type="button">
        {trigger}
      </button>
      {open ? (
        <div className="dx-attachment-modal-backdrop" onClick={() => setOpen(false)}>
          <div className="dx-attachment-modal" onClick={(event) => event.stopPropagation()}>
            <div className="dx-attachment-modal-head">
              <div>
                <p className="dx-approval-row-eyebrow">Private attachment</p>
                <h3>{title}</h3>
              </div>
              <button aria-label="Close" onClick={() => setOpen(false)} type="button"><X /></button>
            </div>
            <div className="dx-attachment-modal-body">
              {downloadError ? <div className="dx-alert error">{downloadError}</div> : null}
              {files.length > 1 ? (
                <div className="dx-attachment-tabs" role="tablist">
                  {files.map((file, index) => (
                    <button aria-selected={index === active} className={index === active ? "active" : ""} key={`${file.label}:${index}`} onClick={() => setActive(index)} role="tab" type="button">
                      {file.label}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="dx-attachment-preview">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt={current.label} src={current.url} />
              </div>
            </div>
            <div className="dx-attachment-modal-foot">
              <a className="dx-attachment-open" href={current.url} rel="noreferrer" target="_blank"><ExternalLink />Open full size</a>
              <button className="dx-attachment-download" disabled={isDownloading} onClick={onDownload} type="button">
                <Download />{isDownloading ? "Downloading…" : "Download"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
