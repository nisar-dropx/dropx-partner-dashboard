"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Search, X } from "lucide-react";
import styles from "./roster-download-modal.module.css";

export type RosterDownloadStation = {
  id: string;
  code: string;
  name: string;
};

type Format = "pdf" | "xlsx";

function matchesQuery(station: RosterDownloadStation, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${station.code} ${station.name}`.toLowerCase().includes(needle);
}

export function RosterDownloadModal({
  stations,
  initialSelectedIds = []
}: {
  stations: RosterDownloadStation[];
  initialSelectedIds?: string[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(
    initialSelectedIds.filter((id) => stations.some((station) => station.id === id))
  ));
  const [format, setFormat] = useState<Format>("pdf");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const visible = useMemo(
    () => stations.filter((station) => matchesQuery(station, query)),
    [query, stations]
  );

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectVisible = () => {
    setSelected((current) => {
      const next = new Set(current);
      for (const station of visible) next.add(station.id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const download = async () => {
    const ids = [...selected];
    if (!ids.length) {
      setError("Select at least one station in your access scope.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams();
      params.set("format", format);
      params.set("stations", ids.join(","));
      const response = await fetch(`/rostering/template?${params.toString()}`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store"
      });
      if (!response.ok) {
        let message = "Roster download failed.";
        try {
          const body = await response.json() as { error?: string };
          if (body.error) message = body.error;
        } catch {
          /* keep default */
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const matched = /filename="([^"]+)"/i.exec(disposition);
      const filename = matched?.[1] || `station-roster.${format === "pdf" ? "pdf" : "xlsx"}`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Roster download failed.");
    } finally {
      setBusy(false);
    }
  };

  if (!stations.length) return null;

  return (
    <>
      <button
        type="button"
        className={`button secondary compact ${styles.trigger}`}
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        <Download size={14} />
        Download rosters
      </button>

      <dialog
        ref={dialog}
        className={styles.dialog}
        onClose={() => setOpen(false)}
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) setOpen(false);
        }}
      >
        <header className={styles.head}>
          <div>
            <h2>Download station rosters</h2>
            <p>Choose stations in your OpsPulse access, then download PDF or Excel of the approved Mon–Sun pattern.</p>
          </div>
          <button type="button" aria-label="Close" onClick={() => !busy && setOpen(false)} disabled={busy}>
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <label className={styles.search}>
            <Search size={15} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search station code or name"
              autoFocus
            />
          </label>

          <div className={styles.toolbar}>
            <span className={styles.count}>{selected.size} selected · {visible.length} shown · {stations.length} accessible</span>
            <div className={styles.toolbarActions}>
              <button type="button" className="button secondary compact" onClick={selectVisible} disabled={!visible.length || busy}>
                Select shown
              </button>
              <button type="button" className="button secondary compact" onClick={() => setSelected(new Set(stations.map((station) => station.id)))} disabled={busy}>
                Select all access
              </button>
              <button type="button" className="button secondary compact" onClick={clearSelection} disabled={!selected.size || busy}>
                Clear
              </button>
            </div>
          </div>

          <div className={styles.list} role="group" aria-label="Accessible stations">
            {visible.length ? visible.map((station) => {
              const checked = selected.has(station.id);
              return (
                <label key={station.id} className={`${styles.option}${checked ? ` ${styles.optionSelected}` : ""}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(station.id)}
                    disabled={busy}
                  />
                  <span>
                    <strong>{station.code}</strong>
                    <small>{station.name}</small>
                  </span>
                </label>
              );
            }) : <div className={styles.empty}>No stations match this search.</div>}
          </div>

          <fieldset className={styles.formats}>
            <legend>Format</legend>
            <div className={styles.formatRow}>
              <label>
                <input type="radio" name="roster-format" checked={format === "pdf"} onChange={() => setFormat("pdf")} disabled={busy} />
                PDF
              </label>
              <label>
                <input type="radio" name="roster-format" checked={format === "xlsx"} onChange={() => setFormat("xlsx")} disabled={busy} />
                Excel
              </label>
            </div>
          </fieldset>
        </div>

        <footer className={styles.foot}>
          {error ? <p className={styles.error}>{error}</p> : <span className={styles.count}>Only stations in your location access can be downloaded.</span>}
          <div className={styles.actions}>
            <button type="button" className="button secondary compact" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
            <button type="button" className="button primary compact" onClick={() => void download()} disabled={busy || !selected.size}>
              <Download size={14} />
              {busy ? "Preparing…" : `Download ${format === "pdf" ? "PDF" : "Excel"}`}
            </button>
          </div>
        </footer>
      </dialog>
    </>
  );
}
