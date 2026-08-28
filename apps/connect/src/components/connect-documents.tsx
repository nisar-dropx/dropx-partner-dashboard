"use client";

import { Download, FileCheck2, FileText, ShieldCheck, WalletCards } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AppAccount } from "./connect-profile-app";

type DocumentRow = {
  id: string;
  kind: "pay" | "issued";
  category: string;
  title: string;
  subtitle: string;
  fileName: string;
  publishedAt: string;
  expiresOn: string | null;
  downloadUrl: string;
};

function title(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

export function ConnectDocuments({ account }: { account: AppAccount }) {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [summary, setSummary] = useState({ total: 0, pay: 0, issued: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const response = await fetch(`/api/connect/documents?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load documents.");
      setDocuments(payload.documents ?? []);
      setSummary(payload.summary ?? { total: 0, pay: 0, issued: 0 });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load documents."); }
    finally { setLoading(false); }
  }, [account.id, account.profileType]);
  useEffect(() => { void load(); }, [load]);

  return <section className="dx-documents">
    <header className="dx-page-intro"><small>My records</small><h1>Documents</h1><p>Salary slips, insurance cards and HR-issued files in one secure place.</p></header>
    <div className="dx-document-summary">
      <div><i><FileCheck2 /></i><span><small>Available</small><strong>{loading ? "—" : summary.total}</strong></span></div>
      <div><i><WalletCards /></i><span><small>Pay documents</small><strong>{loading ? "—" : summary.pay}</strong></span></div>
      <div><i><ShieldCheck /></i><span><small>HR issued</small><strong>{loading ? "—" : summary.issued}</strong></span></div>
    </div>
    {error ? <div className="dx-alert error">{error}<button onClick={() => void load()}>Retry</button></div> : null}
    {loading ? <div className="dx-loader"><span /><small>Loading secure documents…</small></div> : null}
    {!loading && !documents.length ? <div className="dx-document-empty"><FileText /><strong>No documents published yet</strong><small>Salary slips appear after payroll publishing. Insurance cards and other files appear after People &amp; Culture issues them.</small></div> : null}
    {!loading && documents.length ? <div className="dx-document-list">{documents.map((document) => <article key={`${document.kind}:${document.id}`}>
      <i>{document.kind === "pay" ? <WalletCards /> : <FileText />}</i>
      <div><span><em>{title(document.category)}</em>{document.expiresOn ? <small>Expires {new Date(`${document.expiresOn}T00:00:00`).toLocaleDateString("en-IN")}</small> : null}</span><strong>{document.title}</strong><p>{document.subtitle}</p><small>{document.fileName} · Published {new Date(document.publishedAt).toLocaleDateString("en-IN")}</small></div>
      <a href={document.downloadUrl}><Download />Download</a>
    </article>)}</div> : null}
    <p className="dx-document-privacy"><ShieldCheck />Files are private. Every download is checked against the signed-in DropX One account.</p>
  </section>;
}
