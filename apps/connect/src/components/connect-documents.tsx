"use client";

import { BadgeCheck, Download, FileCheck2, FileClock, FilePlus2, FileText, HeartPulse, ShieldCheck, WalletCards, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
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

type RequestType = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  instructions: string | null;
  sla_days: number;
  issued_document_type: string;
};

type DocumentRequest = {
  id: string;
  request_number: string;
  request_type_id: string;
  request_type_name: string;
  reason: string | null;
  status: string;
  hr_note: string | null;
  requested_at: string;
  first_action_at: string | null;
  closed_at: string | null;
  fulfilled_document_id: string | null;
};

type DocumentSection = "payslips" | "insurance" | "hr" | "requests";

function title(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function date(value: string) { return new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }

export function ConnectDocuments({ account }: { account: AppAccount }) {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [requestTypes, setRequestTypes] = useState<RequestType[]>([]);
  const [requests, setRequests] = useState<DocumentRequest[]>([]);
  const [summary, setSummary] = useState({ total: 0, pay: 0, issued: 0, requests: 0 });
  const [section, setSection] = useState<DocumentSection>("payslips");
  const [showRequest, setShowRequest] = useState(false);
  const [requestTypeId, setRequestTypeId] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const response = await fetch(`/api/connect/documents?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load documents.");
      setDocuments(payload.documents ?? []);
      setRequestTypes(payload.requestTypes ?? []);
      setRequests(payload.requests ?? []);
      setSummary(payload.summary ?? { total: 0, pay: 0, issued: 0, requests: 0 });
      setRequestTypeId((current) => current || payload.requestTypes?.[0]?.id || "");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load documents."); }
    finally { setLoading(false); }
  }, [account.id, account.profileType]);

  useEffect(() => { void load(); }, [load]);

  async function submitRequest(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType, requestTypeId, reason })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to submit document request.");
      setReason(""); setShowRequest(false); setSection("requests"); setNotice(payload.message || "Document request submitted.");
      await load();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Unable to submit document request."); }
    finally { setSubmitting(false); }
  }

  const selectedType = requestTypes.find((type) => type.id === requestTypeId);
  const rows = documents.filter((document) => section === "payslips"
    ? document.kind === "pay"
    : section === "insurance"
      ? document.kind === "issued" && document.category === "insurance card"
      : section === "hr"
        ? document.kind === "issued" && document.category !== "insurance card"
        : false);
  const issuedDocumentById = new Map(documents.filter((document) => document.kind === "issued").map((document) => [document.id, document]));

  const tabs: Array<{ key: DocumentSection; label: string; count: number; icon: typeof FileText }> = [
    { key: "payslips", label: account.profileType === "employee" ? "Payslips" : "Pay statements", count: summary.pay, icon: WalletCards },
    { key: "insurance", label: "Insurance", count: documents.filter((document) => document.kind === "issued" && document.category === "insurance card").length, icon: HeartPulse },
    { key: "hr", label: "HR documents", count: documents.filter((document) => document.kind === "issued" && document.category !== "insurance card").length, icon: FileCheck2 },
    { key: "requests", label: "Requests", count: requests.length, icon: FileClock }
  ];

  return <section className="dx-documents">
    <header className="dx-page-intro dx-documents-head"><div><small>My records</small><h1>Documents</h1><p>Payslips, insurance and official HR records—organised by type.</p></div><button disabled={!requestTypes.length} onClick={() => setShowRequest(true)}><FilePlus2 />Request document</button></header>
    <div className="dx-document-summary">
      <div><i><FileCheck2 /></i><span><small>Available</small><strong>{loading ? "—" : summary.total}</strong></span></div>
      <div><i><WalletCards /></i><span><small>{account.profileType === "employee" ? "Payslips" : "Pay statements"}</small><strong>{loading ? "—" : summary.pay}</strong></span></div>
      <div><i><FileClock /></i><span><small>Open requests</small><strong>{loading ? "—" : summary.requests}</strong></span></div>
    </div>
    {notice ? <div className="dx-alert success">{notice}<button onClick={() => setNotice("")}><X /></button></div> : null}
    {error ? <div className="dx-alert error">{error}<button onClick={() => void load()}>Retry</button></div> : null}
    <nav aria-label="Document categories" className="dx-document-tabs">{tabs.map((tab) => { const Icon = tab.icon; return <button aria-current={section === tab.key ? "page" : undefined} className={section === tab.key ? "active" : ""} key={tab.key} onClick={() => setSection(tab.key)}><Icon /><span>{tab.label}</span><b>{tab.count}</b></button>; })}</nav>
    {loading ? <div className="dx-loader"><span /><small>Loading secure documents…</small></div> : null}
    {!loading && section !== "requests" && !rows.length ? <div className="dx-document-empty"><FileText /><strong>No {tabs.find((tab) => tab.key === section)?.label.toLowerCase()} yet</strong><small>{section === "payslips" ? "Completed payroll publishes your document here automatically." : "Use Request document if you need an HR-issued record that is not available."}</small></div> : null}
    {!loading && section !== "requests" && rows.length ? <div className="dx-document-list">{rows.map((document) => <article key={`${document.kind}:${document.id}`}>
      <i>{document.kind === "pay" ? <WalletCards /> : document.category === "insurance card" ? <HeartPulse /> : <FileText />}</i>
      <div><span><em>{title(document.category)}</em>{document.expiresOn ? <small>Expires {date(`${document.expiresOn}T00:00:00`)}</small> : null}</span><strong>{document.title}</strong><p>{document.subtitle}</p><small>{document.fileName} · Published {date(document.publishedAt)}</small></div>
      <a href={document.downloadUrl}><Download />Download</a>
    </article>)}</div> : null}
    {!loading && section === "requests" ? <div className="dx-document-request-list">{requests.length ? requests.map((request) => { const issued = request.fulfilled_document_id ? issuedDocumentById.get(request.fulfilled_document_id) : null; return <article key={request.id}>
      <i className={`status-${request.status}`}>{request.status === "fulfilled" ? <BadgeCheck /> : <FileClock />}</i>
      <div><span><strong>{request.request_type_name}</strong><em>{request.request_number}</em></span><p>{request.reason || "No additional note"}</p>{request.hr_note ? <small>People &amp; Culture: {request.hr_note}</small> : null}<small>Requested {date(request.requested_at)}</small></div>
      <span className={`dx-request-status ${request.status}`}>{title(request.status)}</span>
      {issued ? <a href={issued.downloadUrl}><Download />Download</a> : request.status === "returned" ? <button onClick={() => { setRequestTypeId(request.request_type_id); setReason(request.reason || ""); setShowRequest(true); }}>Update request</button> : null}
    </article>; }) : <div className="dx-document-empty"><FileClock /><strong>No document requests</strong><small>Request a missing HR document and track it here until it is ready.</small></div>}</div> : null}
    <p className="dx-document-privacy"><ShieldCheck />Files are private. Every download is checked against the signed-in DropX One account.</p>
    {showRequest ? <div className="dx-document-request-modal" role="dialog" aria-modal="true" aria-labelledby="document-request-title"><button aria-label="Close request form" className="dx-document-request-scrim" onClick={() => setShowRequest(false)} /><form onSubmit={submitRequest}><header><span><small>People &amp; Culture</small><h2 id="document-request-title">Request a document</h2></span><button aria-label="Close" onClick={() => setShowRequest(false)} type="button"><X /></button></header><label>Document type<select required value={requestTypeId} onChange={(event) => setRequestTypeId(event.target.value)}>{requestTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>{selectedType ? <div className="dx-document-request-guidance"><strong>{selectedType.description}</strong><span>{selectedType.instructions || "Add any detail People & Culture needs to prepare the document."}</span><small>Target turnaround: {selectedType.sla_days} working days</small></div> : null}<label>Purpose or details<textarea maxLength={500} minLength={3} onChange={(event) => setReason(event.target.value)} placeholder="Mention purpose, period or addressee if relevant" required value={reason} /></label><button disabled={submitting || !requestTypeId || reason.trim().length < 3}>{submitting ? "Submitting…" : "Submit request"}</button></form></div> : null}
  </section>;
}
