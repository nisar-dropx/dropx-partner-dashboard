"use client";

import { ArrowLeft, BadgeCheck, ChevronRight, Download, FileCheck2, FileClock, FilePlus2, FileText, HeartPulse, LoaderCircle, Paperclip, Send, ShieldCheck, WalletCards, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AppAccount } from "./connect-profile-app";
import { useKeepAliveRefresh } from "../lib/use-keep-alive-refresh";

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

type RequestMessage = { id: string; author_kind: "requester" | "people_team" | "system"; body: string; created_at: string };
type RequestAttachment = { id: string; message_id: string | null; original_name: string; file_size: number; created_at: string };

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
  messages: RequestMessage[];
  attachments: RequestAttachment[];
};

type DocumentSection = "payslips" | "insurance" | "hr" | "requests";

function title(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function date(value: string) { return new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
function shortDate(value: string) { return new Date(value).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }
function readableSize(value: number) { return value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`; }

const statusLabels: Record<string, string> = {
  submitted: "Submitted",
  in_progress: "Being prepared",
  returned: "Needs your input",
  fulfilled: "Ready to download",
  rejected: "Rejected",
  cancelled: "Cancelled"
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ConnectDocuments({ account, active = true }: { account: AppAccount; active?: boolean }) {
  const workforce = account.workspace === "workforce" || ["workforce", "field_executive", "vendor", "worker"].includes(account.profileType);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [requestTypes, setRequestTypes] = useState<RequestType[]>([]);
  const [requests, setRequests] = useState<DocumentRequest[]>([]);
  const [summary, setSummary] = useState({ total: 0, pay: 0, issued: 0, requests: 0 });
  const [section, setSection] = useState<DocumentSection>("payslips");
  const [showRequest, setShowRequest] = useState(false);
  const [selectedRequestId, setSelectedRequestId] = useState("");
  const [requestTypeId, setRequestTypeId] = useState("");
  const [reason, setReason] = useState("");
  const [reply, setReply] = useState("");
  const [attachFile, setAttachFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [forwardingMessageId, setForwardingMessageId] = useState("");
  const [forwardEmail, setForwardEmail] = useState("");
  const [forwarding, setForwarding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { markLoaded, setReload } = useKeepAliveRefresh(active);

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    setError("");
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
      markLoaded();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load documents."); }
    finally { if (!background) setLoading(false); }
  }, [account.id, account.profileType, markLoaded]);
  setReload(() => load(true));

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

  async function sendReply(event: FormEvent) {
    event.preventDefault();
    if (!selectedRequestId || !reply.trim()) return;
    setSubmitting(true); setError("");
    try {
      const response = await fetch("/api/connect/documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType, requestId: selectedRequestId, message: reply })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to send your message.");
      let messageId: string | undefined = payload.messageId;
      if (attachFile) {
        const form = new FormData();
        form.set("accountId", account.id);
        form.set("profileType", account.profileType);
        form.set("requestId", selectedRequestId);
        if (messageId) form.set("messageId", messageId);
        form.set("file", attachFile);
        const uploadResponse = await fetch("/api/connect/documents", { method: "POST", body: form });
        const uploadPayload = await uploadResponse.json();
        if (!uploadResponse.ok) throw new Error(uploadPayload.error || "Message sent, but the attachment could not be uploaded.");
      }
      setReply(""); setAttachFile(null);
      await load(true);
    } catch (replyError) { setError(replyError instanceof Error ? replyError.message : "Unable to send your message."); }
    finally { setSubmitting(false); }
  }

  async function forwardMessage(event: FormEvent) {
    event.preventDefault();
    if (!forwardingMessageId || !forwardEmail.trim()) return;
    setForwarding(true); setError("");
    try {
      const response = await fetch("/api/connect/documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType, forwardMessageId: forwardingMessageId, forwardEmail: forwardEmail.trim() })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to forward this message.");
      setForwardingMessageId(""); setForwardEmail("");
    } catch (forwardError) { setError(forwardError instanceof Error ? forwardError.message : "Unable to forward this message."); }
    finally { setForwarding(false); }
  }

  async function openAttachment(id: string) {
    setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType, attachmentId: id });
      const response = await fetch(`/api/connect/documents?${query}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.url) throw new Error(payload.error || "Attachment is unavailable.");
      window.open(payload.url, "_blank", "noopener,noreferrer");
    } catch (attachmentError) { setError(attachmentError instanceof Error ? attachmentError.message : "Attachment is unavailable."); }
  }

  const selectedType = requestTypes.find((type) => type.id === requestTypeId);
  const selectedRequest = requests.find((request) => request.id === selectedRequestId) ?? null;
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

  if (selectedRequest) {
    const closed = ["fulfilled", "rejected", "cancelled"].includes(selectedRequest.status);
    return <section className="dx-documents dx-document-request-detail">
      <button className="dx-communication-back" onClick={() => setSelectedRequestId("")}><ArrowLeft />Requests</button>
      <header className="dx-case-hero help">
        <div><span>{selectedRequest.request_number}</span><h1>{selectedRequest.request_type_name}</h1><p>Requested {shortDate(selectedRequest.requested_at)}</p></div>
        <b className={`dx-case-status ${selectedRequest.status}`}>{statusLabels[selectedRequest.status] ?? title(selectedRequest.status)}</b>
      </header>
      {error ? <div className="dx-alert error">{error}<button aria-label="Dismiss" onClick={() => setError("")}><X /></button></div> : null}
      {selectedRequest.reason ? <p className="dx-document-request-reason"><strong>Your request:</strong> {selectedRequest.reason}</p> : null}
      <div className="dx-case-timeline">
        {selectedRequest.messages.length ? selectedRequest.messages.map((message) => {
          const attachments = selectedRequest.attachments.filter((attachment) => attachment.message_id === message.id);
          return <article className={message.author_kind === "requester" ? "mine" : "committee"} key={message.id}>
            <span>{message.author_kind === "requester" ? "You" : message.author_kind === "people_team" ? "People & Culture" : "System"}</span>
            <p>{message.body}</p>
            {attachments.map((attachment) => <button className="dx-message-attachment" key={attachment.id} onClick={() => void openAttachment(attachment.id)} type="button"><FileText /><span>{attachment.original_name}<small>{readableSize(attachment.file_size)}</small></span></button>)}
            <small>{shortDate(message.created_at)}</small>
            {forwardingMessageId === message.id ? (
              <form className="dx-message-forward" onSubmit={forwardMessage}>
                <input aria-label="Forward to email address" onChange={(event) => setForwardEmail(event.target.value)} placeholder="name@example.com" required type="email" value={forwardEmail} />
                <button disabled={forwarding} type="submit">{forwarding ? <LoaderCircle /> : <Send />}Send</button>
                <button onClick={() => { setForwardingMessageId(""); setForwardEmail(""); }} type="button">Cancel</button>
              </form>
            ) : (
              <button className="dx-message-forward-trigger" onClick={() => { setForwardingMessageId(message.id); setForwardEmail(""); }} type="button">Forward to email</button>
            )}
          </article>;
        }) : <div className="dx-empty-cases"><FileClock /><strong>No messages yet</strong><span>Send a message if People &amp; Culture needs more detail from you.</span></div>}
      </div>
      {selectedRequest.attachments.filter((attachment) => !attachment.message_id).length ? <div className="dx-evidence-list"><strong>Attachments</strong>{selectedRequest.attachments.filter((attachment) => !attachment.message_id).map((attachment) => <button key={attachment.id} onClick={() => void openAttachment(attachment.id)}><FileText /><span>{attachment.original_name}<small>{readableSize(attachment.file_size)}</small></span><ChevronRight /></button>)}</div> : null}
      {selectedRequest.fulfilled_document_id ? <div className="dx-alert success">Your document is ready — download it from the {statusLabels.fulfilled === "Ready to download" ? "HR documents" : ""} tab.</div> : null}
      {!closed ? <form className="dx-case-reply" onSubmit={sendReply}>
        <label>Reply<textarea maxLength={3000} onChange={(event) => setReply(event.target.value)} placeholder="Add detail or answer People & Culture…" value={reply} /></label>
        <div className="dx-evidence-picker"><input accept="image/jpeg,image/png,image/webp,application/pdf" hidden onChange={(event) => setAttachFile(event.target.files?.[0] ?? null)} ref={fileRef} type="file" /><button onClick={() => fileRef.current?.click()} type="button"><Paperclip />{attachFile ? "Change file" : "Attach a file (optional)"}</button>{attachFile ? <span>{attachFile.name}<button aria-label="Remove attachment" onClick={() => setAttachFile(null)} type="button"><X /></button></span> : null}</div>
        <button disabled={submitting || reply.trim().length < 1}>{submitting ? <LoaderCircle /> : <Send />}Send reply</button>
      </form> : null}
    </section>;
  }

  return <section className="dx-documents">
    <header className="dx-page-intro dx-documents-head"><div><small>My records</small><h1>Documents</h1><p>{workforce ? "Insurance, Form 16 and official workforce records—kept private and ready when issued." : "Payslips, insurance and official HR records—organised by type."}</p></div>{requestTypes.length ? <button onClick={() => setShowRequest(true)}><FilePlus2 />Request document</button> : null}</header>
    <div className="dx-document-summary">
      <div><i><FileCheck2 /></i><span><small>Available</small><strong>{loading ? "—" : summary.total}</strong></span></div>
      <div><i><WalletCards /></i><span><small>{workforce ? "Payment docs" : account.profileType === "employee" ? "Payslips" : "Pay statements"}</small><strong>{loading ? "—" : summary.pay}</strong></span></div>
      <div><i><FileClock /></i><span><small>Open requests</small><strong>{loading ? "—" : summary.requests}</strong></span></div>
    </div>
    {notice ? <div className="dx-alert success">{notice}<button aria-label="Dismiss" onClick={() => setNotice("")}><X /></button></div> : null}
    {error ? <div className="dx-alert error">{error}<button onClick={() => void load()}>Retry</button></div> : null}
    <nav aria-label="Document categories" className="dx-document-tabs">{tabs.map((tab) => { const Icon = tab.icon; return <button aria-current={section === tab.key ? "page" : undefined} className={section === tab.key ? "active" : ""} key={tab.key} onClick={() => setSection(tab.key)}><Icon /><span>{tab.label}</span><b>{tab.count}</b></button>; })}</nav>
    {loading ? <div className="dx-loader"><span /><small>Loading secure documents…</small></div> : null}
    {!loading && section !== "requests" && !rows.length ? <div className="dx-document-empty"><FileText /><strong>No {tabs.find((tab) => tab.key === section)?.label.toLowerCase()} yet</strong><small>{section === "payslips" ? "Completed payroll publishes your document here automatically." : "Use Request document if you need an HR-issued record that is not available."}</small></div> : null}
    {!loading && section !== "requests" && rows.length ? <div className="dx-document-list">{rows.map((document) => <article key={`${document.kind}:${document.id}`}>
      <i>{document.kind === "pay" ? <WalletCards /> : document.category === "insurance card" ? <HeartPulse /> : <FileText />}</i>
      <div><span><em>{title(document.category)}</em>{document.expiresOn ? <small>Expires {date(`${document.expiresOn}T00:00:00`)}</small> : null}</span><strong>{document.title}</strong><p>{document.subtitle}</p><small>{document.fileName} · Published {date(document.publishedAt)}</small></div>
      <a href={document.downloadUrl}><Download />Download</a>
    </article>)}</div> : null}
    {!loading && section === "requests" ? <div className="dx-document-request-list">{requests.length ? requests.map((request) => { const issued = request.fulfilled_document_id ? issuedDocumentById.get(request.fulfilled_document_id) : null; return <button className="dx-document-request-row" key={request.id} onClick={() => setSelectedRequestId(request.id)} type="button">
      <i className={`status-${request.status}`}>{request.status === "fulfilled" ? <BadgeCheck /> : <FileClock />}</i>
      <div><span><strong>{request.request_type_name}</strong><em>{request.request_number}</em></span><p>{request.reason || "No additional note"}</p><small>Requested {date(request.requested_at)} · {request.messages.length} message{request.messages.length === 1 ? "" : "s"}</small></div>
      <span className={`dx-request-status ${request.status}`}>{statusLabels[request.status] ?? title(request.status)}</span>
      {issued ? <a href={issued.downloadUrl} onClick={(event) => event.stopPropagation()}><Download />Download</a> : <ChevronRight />}
    </button>; }) : <div className="dx-document-empty"><FileClock /><strong>No document requests</strong><small>Request a missing HR document and track it here until it is ready.</small></div>}</div> : null}
    <p className="dx-document-privacy"><ShieldCheck />Files are private. Every download is checked against the signed-in DropX One account.</p>
    {showRequest ? <div className="dx-document-request-modal" role="dialog" aria-modal="true" aria-labelledby="document-request-title"><button aria-label="Close request form" className="dx-document-request-scrim" onClick={() => setShowRequest(false)} /><form onSubmit={submitRequest}><header><span><small>People &amp; Culture</small><h2 id="document-request-title">Request a document</h2></span><button aria-label="Close" onClick={() => setShowRequest(false)} type="button"><X /></button></header><label>Document type<select required value={requestTypeId} onChange={(event) => setRequestTypeId(event.target.value)}>{requestTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>{selectedType ? <div className="dx-document-request-guidance"><strong>{selectedType.description}</strong><span>{selectedType.instructions || "Add any detail People & Culture needs to prepare the document."}</span><small>Target turnaround: {selectedType.sla_days} working days</small></div> : null}<label>Purpose or details<textarea maxLength={500} minLength={3} onChange={(event) => setReason(event.target.value)} placeholder="Mention purpose, period or addressee if relevant" required value={reason} /></label><button disabled={submitting || !requestTypeId || reason.trim().length < 3}>{submitting ? "Submitting…" : "Submit request"}</button></form></div> : null}
  </section>;
}
