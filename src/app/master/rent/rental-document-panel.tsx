"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { rentalDocumentAccept, validateRentalFile, type RentalDocument } from "@/lib/finance/rental-document";
import type { RentRecord } from "@/lib/finance/rent";

type DocumentState = { documents: RentalDocument[]; currentId: string | null; updatedAt: string };

export function RentalDocumentPanel({ record, canEdit, onClose }: {
  record: RentRecord; canEdit: boolean; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [state, setState] = useState<DocumentState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const endpoint = `/api/finance/rent/${record.id}/documents`;

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(endpoint, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
        throw new Error("Unable to load documents. Check your connection and access, then retry.");
      const data: DocumentState = await response.json();
      if (controller.signal.aborted) return;
      setState(data);
      setSelected(data.currentId);
      setError("");
    }).catch((caught) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Unable to load documents.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, reload]);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file || !state || pending || loading) return;
    setError("");
    setNotice("");
    try { validateRentalFile(file); }
    catch (caught) { setError((caught as Error).message); return; }
    setPending(true);
    const form = new FormData();
    form.append("file", file);
    form.append("expected_updated_at", state.updatedAt);
    try {
      const response = await fetch(endpoint, { method: "POST", body: form });
      if (!response.headers.get("content-type")?.includes("application/json"))
        throw new Error("Upload interrupted. Reopen Documents to check before retrying.");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to upload the agreement.");
      setNotice(state.currentId ? "Agreement replaced. The previous version is retained below." : "Rental agreement uploaded.");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setReload((value) => value + 1);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload interrupted. Reopen Documents to check before retrying.");
    } finally { setPending(false); }
  }

  const chosen = state?.documents.find((document) => document.id === selected);
  return (
    <dialog ref={dialog} className="fin-dialog fin-rental-document-dialog" aria-label={`Rental agreement · ${record.site_code}`}
      onCancel={(event) => { event.preventDefault(); if (!pending) onClose(); }}>
      <div className="fin-dialog-head">
        <div><h2>Rental agreement · {record.site_code}</h2><p className="subtle">{record.payee_name} · Allocated to {record.allocation_station_code}</p></div>
        <button className="button secondary" type="button" disabled={pending} onClick={onClose}>Close</button>
      </div>
      {notice && <div className="fin-notice success" role="status">{notice}</div>}
      {error && <div className="fin-notice error" role="alert">{error} <button className="button secondary small" type="button" disabled={pending || loading} onClick={() => setReload((value) => value + 1)}>Reload documents</button></div>}
      {loading ? <p role="status">Loading rental documents…</p> : state && <>
        {chosen ? <>
          <div className="fin-toolbar">
            <div><strong>{chosen.file_name}</strong><p className="subtle">{chosen.id === state.currentId ? "Current agreement" : "Previous version"} · {(chosen.file_size / 1024).toFixed(0)} KB · {new Date(chosen.uploaded_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</p></div>
            <a className="button secondary" href={`${endpoint}/${chosen.id}?download=1`}>Download agreement</a>
          </div>
          <iframe key={chosen.id} className="fin-rental-document-preview" src={`${endpoint}/${chosen.id}`} title={`Preview of ${chosen.file_name}`} referrerPolicy="no-referrer" />
          <p className="subtle">If your browser cannot display the preview, use Download agreement.</p>
        </> : <div className="fin-notice">No rental agreement uploaded yet.</div>}
        {canEdit && <form onSubmit={upload} className="fin-rental-document-upload">
          <label className="fin-label">{state.currentId ? "Replace uploaded agreement" : "Upload rental agreement"}
            <input ref={fileInput} type="file" accept={rentalDocumentAccept} required disabled={pending} onChange={(event) => { setFile(event.target.files?.[0] || null); setError(""); }} />
          </label>
          <p className="subtle">PDF, JPG or PNG · Up to 4 MB. Replacing a file preserves previous versions and does not change rent amounts.</p>
          <button className="button" type="submit" disabled={!file || pending}>{pending ? "Uploading… Please keep this window open" : state.currentId ? "Replace rental agreement" : "Upload rental agreement"}</button>
        </form>}
        {!!state.documents.length && <details className="fin-rental-document-history">
          <summary>Document history ({state.documents.length}{state.documents.length === 50 ? " most recent" : ""})</summary>
          <ul>{state.documents.map((document) => <li key={document.id}>
            <button type="button" className="button secondary small" aria-pressed={selected === document.id} onClick={() => setSelected(document.id)}>{document.file_name}{document.id === state.currentId ? " · Current" : " · Previous"}</button>{" "}
            <span className="subtle">{new Date(document.uploaded_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</span>
          </li>)}</ul>
        </details>}
      </>}
    </dialog>
  );
}
