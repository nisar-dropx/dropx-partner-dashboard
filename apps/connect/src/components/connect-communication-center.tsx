"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeIndianRupee,
  CheckCircle2,
  ChevronRight,
  FileText,
  Headphones,
  LoaderCircle,
  LockKeyhole,
  Megaphone,
  MessageCircleMore,
  Paperclip,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import type { AppAccount } from "./connect-profile-app";

type Channel = "general" | "connect" | "integrity";
type Section = "updates" | "hr-help" | "speak-up";
type ChannelSetting = {
  active: boolean;
  allowAttachments: boolean;
  categories: string[];
  channel: Channel;
  guidance: string;
  rewardEnabled: boolean;
  slaHours: number;
  subtitle: string;
  title: string;
};
type CaseMessage = { id: string; author_kind: "reporter" | "committee" | "system"; body: string; created_at: string };
type CaseAttachment = { id: string; original_name: string; file_size: number; created_at: string };
type CommunicationCase = {
  id: string;
  case_number: string;
  channel: Channel;
  category: string;
  subject: string;
  description: string;
  urgency: string;
  status: string;
  reward_status: string;
  due_at?: string | null;
  last_activity_at: string;
  created_at: string;
  messages: CaseMessage[];
  attachments: CaseAttachment[];
};
type Announcement = {
  id: string;
  category: string;
  title: string;
  body: string;
  priority: "normal" | "important" | "urgent";
  published_at: string;
  readAt?: string | null;
};

const statusLabels: Record<string, string> = {
  submitted: "Submitted",
  acknowledged: "Acknowledged",
  in_review: "Under review",
  action_required: "Your input needed",
  resolved: "Resolved",
  closed: "Closed",
  dismissed: "Closed after review"
};

function shortDate(value: string) {
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function readableSize(value: number) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function ConnectCommunicationCenter({ account }: { account: AppAccount }) {
  const [section, setSection] = useState<Section>("updates");
  const [settings, setSettings] = useState<ChannelSetting[]>([]);
  const [cases, setCases] = useState<CommunicationCase[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [selectedAnnouncementId, setSelectedAnnouncementId] = useState("");
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [category, setCategory] = useState("");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [urgency, setUrgency] = useState("normal");
  const [files, setFiles] = useState<File[]>([]);
  const [reply, setReply] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const query = useMemo(
    () => new URLSearchParams({ accountId: account.id, profileType: account.profileType }),
    [account.id, account.profileType]
  );
  const selectedCase = cases.find((item) => item.id === selectedCaseId) ?? null;
  const selectedAnnouncement = announcements.find((item) => item.id === selectedAnnouncementId) ?? null;
  const activeSetting = settings.find((item) => item.channel === selectedChannel) ?? null;

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/connect/communication-center?${query}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to open Connect.");
      setSettings(payload.settings ?? []);
      setCases(payload.cases ?? []);
      setAnnouncements(payload.announcements ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to open Connect.");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  function startCase(channel: Exclude<Channel, "general">) {
    const setting = settings.find((item) => item.channel === channel);
    if (!setting?.active) return;
    setSelectedChannel(channel);
    setCategory(setting.categories[0] ?? "");
    setSubject("");
    setDescription("");
    setUrgency("normal");
    setFiles([]);
    setSuccess("");
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selectedChannel) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const form = new FormData();
      form.set("accountId", account.id);
      form.set("profileType", account.profileType);
      form.set("channel", selectedChannel);
      form.set("category", category);
      form.set("subject", subject);
      form.set("description", description);
      form.set("urgency", urgency);
      files.forEach((file) => form.append("evidence", file));
      const response = await fetch("/api/connect/communication-center", { method: "POST", body: form });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to submit your message.");
      setSuccess(`Submitted. Your reference is ${payload.caseNumber}.`);
      setSelectedChannel(null);
      await load(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to submit your message.");
    } finally {
      setSaving(false);
    }
  }

  async function sendReply(event: FormEvent) {
    event.preventDefault();
    if (!selectedCase || !reply.trim()) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/connect/communication-center", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, profileType: account.profileType, caseId: selectedCase.id, message: reply })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to send your message.");
      setReply("");
      await load(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to send your message.");
    } finally {
      setSaving(false);
    }
  }

  async function openAttachment(id: string) {
    setError("");
    try {
      const attachmentQuery = new URLSearchParams(query);
      attachmentQuery.set("attachmentId", id);
      const response = await fetch(`/api/connect/communication-center?${attachmentQuery}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.url) throw new Error(payload.error || "Evidence is unavailable.");
      window.open(payload.url, "_blank", "noopener,noreferrer");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Evidence is unavailable.");
    }
  }

  async function openAnnouncement(item: Announcement) {
    setSelectedAnnouncementId(item.id);
    if (item.readAt) return;
    setAnnouncements((current) => current.map((entry) => entry.id === item.id
      ? { ...entry, readAt: new Date().toISOString() }
      : entry));
    await fetch("/api/connect/communication-center", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: account.id, profileType: account.profileType, announcementId: item.id })
    }).catch(() => undefined);
  }

  if (loading) {
    return <div className="dx-communication-loading"><LoaderCircle /><span>Opening Connect…</span></div>;
  }

  if (selectedAnnouncement) {
    return <section className="dx-communication dx-communication-detail">
      <button className="dx-communication-back" onClick={() => setSelectedAnnouncementId("")}><ArrowLeft />Updates</button>
      <header className={`dx-case-hero announcement ${selectedAnnouncement.priority}`}>
        <div><span>{selectedAnnouncement.category}</span><h1>{selectedAnnouncement.title}</h1><p>{shortDate(selectedAnnouncement.published_at)}</p></div>
        <Megaphone />
      </header>
      <div className="dx-privacy-strip announcement"><CheckCircle2 /><span><strong>Official DropX communication.</strong> This update is read-only and was sent to your team.</span></div>
      <article className="dx-announcement-body">{selectedAnnouncement.body.split("\n").map((line, index) => <p key={`${index}-${line}`}>{line || <>&nbsp;</>}</p>)}</article>
    </section>;
  }

  if (selectedCase) {
    const confidential = selectedCase.channel === "integrity";
    return <section className="dx-communication dx-communication-detail">
      <button className="dx-communication-back" onClick={() => setSelectedCaseId("")}><ArrowLeft />{confidential ? "Speak Up cases" : "HR Help"}</button>
      <header className={`dx-case-hero ${confidential ? "confidential" : "help"}`}>
        <div><span>{selectedCase.case_number}</span><h1>{selectedCase.subject}</h1><p>{selectedCase.category} · {shortDate(selectedCase.created_at)}</p></div>
        <b className={`dx-case-status ${selectedCase.status}`}>{statusLabels[selectedCase.status] ?? selectedCase.status}</b>
      </header>
      <div className="dx-privacy-strip"><LockKeyhole /><span>{confidential
        ? <><strong>Confidential conversation.</strong> Your identity is separated from the case shown to ordinary reviewers.</>
        : <><strong>Private HR conversation.</strong> Only you and authorised People team members can access this thread.</>}</span></div>
      {error ? <div className="dx-communication-alert error"><AlertTriangle />{error}<button aria-label="Dismiss error" onClick={() => setError("")}><X /></button></div> : null}
      <div className="dx-case-timeline">
        {(selectedCase.messages ?? []).map((message) => <article className={message.author_kind === "reporter" ? "mine" : "committee"} key={message.id}>
          <span>{message.author_kind === "reporter" ? "You" : "People & Culture"}</span>
          <p>{message.body}</p>
          <small>{shortDate(message.created_at)}</small>
        </article>)}
      </div>
      {selectedCase.attachments?.length ? <div className="dx-evidence-list"><strong>Attachments</strong>{selectedCase.attachments.map((file) => <button key={file.id} onClick={() => void openAttachment(file.id)}><FileText /><span>{file.original_name}<small>{readableSize(file.file_size)}</small></span><ChevronRight /></button>)}</div> : null}
      {!(["closed", "dismissed"].includes(selectedCase.status)) ? <form className="dx-case-reply" onSubmit={sendReply}><label>Reply<textarea maxLength={3000} onChange={(event) => setReply(event.target.value)} placeholder="Add an update or answer the People team…" value={reply} /></label><button disabled={saving || reply.trim().length < 2}>{saving ? <LoaderCircle /> : <Send />}Send reply</button></form> : null}
    </section>;
  }

  if (selectedChannel && activeSetting) {
    const confidential = selectedChannel === "integrity";
    return <section className="dx-communication dx-new-case">
      <button className="dx-communication-back" onClick={() => setSelectedChannel(null)}><ArrowLeft />{confidential ? "Speak Up" : "HR Help"}</button>
      <header className={`dx-new-case-hero ${confidential ? "coral" : "violet"}`}><i>{confidential ? <ShieldCheck /> : <Headphones />}</i><div><span>{confidential ? "CONFIDENTIAL REPORT" : "PRIVATE HR CONVERSATION"}</span><h1>{activeSetting.title}</h1><p>{activeSetting.guidance}</p></div></header>
      <div className="dx-privacy-strip"><LockKeyhole /><span>{confidential
        ? <><strong>Confidential by design.</strong> Reporter identity is stored separately from the review case.</>
        : <><strong>Private and access-controlled.</strong> This message goes to the authorised People team.</>}</span></div>
      {confidential && activeSetting.rewardEnabled ? <div className="dx-reward-note"><BadgeIndianRupee /><span><strong>Integrity reward</strong> Verified reports may be considered under the company reward policy after review.</span></div> : null}
      {error ? <div className="dx-communication-alert error"><AlertTriangle />{error}<button aria-label="Dismiss error" onClick={() => setError("")}><X /></button></div> : null}
      <form className="dx-communication-form" onSubmit={submit}>
        <label>Category<select onChange={(event) => setCategory(event.target.value)} value={category}>{activeSetting.categories.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>Subject<input maxLength={140} onChange={(event) => setSubject(event.target.value)} placeholder="A short, clear summary" value={subject} /></label>
        {confidential ? <label>Urgency<select onChange={(event) => setUrgency(event.target.value)} value={urgency}><option value="normal">Normal</option><option value="high">High</option><option value="critical">Immediate safety risk</option></select></label> : null}
        <label>Details<textarea maxLength={5000} onChange={(event) => setDescription(event.target.value)} placeholder="Include dates, places and facts. Avoid assumptions where possible." value={description} /><small>{description.length}/5000</small></label>
        {activeSetting.allowAttachments ? <div className="dx-evidence-picker"><input accept="image/jpeg,image/png,image/webp,application/pdf,audio/*,video/mp4" hidden multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []).slice(0, 3))} ref={fileRef} type="file" /><button onClick={() => fileRef.current?.click()} type="button"><Paperclip />Add evidence</button><span>{files.length ? `${files.length} file${files.length > 1 ? "s" : ""} selected` : "Up to 3 files · 8 MB each"}</span></div> : null}
        {files.map((file) => <div className="dx-selected-file" key={`${file.name}-${file.size}`}><FileText /><span>{file.name}<small>{readableSize(file.size)}</small></span><button aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((item) => item !== file))} type="button"><X /></button></div>)}
        <button className="dx-submit-case" disabled={saving || subject.trim().length < 5 || description.trim().length < 20}>{saving ? <LoaderCircle /> : confidential ? <ShieldCheck /> : <Send />}{saving ? "Submitting…" : confidential ? "Submit confidentially" : "Send to HR"}</button>
      </form>
    </section>;
  }

  const channel = section === "speak-up" ? "integrity" : "connect";
  const channelCases = cases.filter((item) => item.channel === channel);
  const channelSetting = settings.find((item) => item.channel === channel);
  const confidential = section === "speak-up";

  return <section className="dx-communication">
    <header className="dx-communication-hero"><div><span><Sparkles />INFORMED · SUPPORTED · HEARD</span><h1>Connect</h1><p>Company updates, private HR conversations and confidential reporting in one trusted place.</p></div><MessageCircleMore /></header>
    {success ? <div className="dx-communication-alert success"><CheckCircle2 />{success}<button aria-label="Dismiss message" onClick={() => setSuccess("")}><X /></button></div> : null}
    {error ? <div className="dx-communication-alert error"><AlertTriangle />{error}<button aria-label="Dismiss error" onClick={() => setError("")}><X /></button></div> : null}
    <nav aria-label="Connect sections" className="dx-connect-tabs">
      <button className={section === "updates" ? "active" : ""} onClick={() => setSection("updates")}><Megaphone /><span>Updates</span>{announcements.filter((item) => !item.readAt).length ? <b>{announcements.filter((item) => !item.readAt).length}</b> : null}</button>
      <button className={section === "hr-help" ? "active" : ""} onClick={() => setSection("hr-help")}><Headphones /><span>HR Help</span></button>
      <button className={section === "speak-up" ? "active" : ""} onClick={() => setSection("speak-up")}><ShieldCheck /><span>Speak Up</span></button>
    </nav>

    {section === "updates" ? <div className="dx-announcement-panel"><header><div><span><Megaphone />COMPANY COMMUNICATION</span><h2>Updates</h2><p>Announcements, policies, incentives and rollout plans from DropX.</p></div><b>{announcements.filter((item) => !item.readAt).length} new</b></header><div>{announcements.length ? announcements.slice(0, 30).map((item) => <button className={item.readAt ? "read" : "unread"} key={item.id} onClick={() => void openAnnouncement(item)}><i className={item.priority}><Megaphone /></i><span><small>{item.category} · {shortDate(item.published_at)}</small><strong>{item.title}</strong><em>{item.body.slice(0, 120)}{item.body.length > 120 ? "…" : ""}</em></span><ChevronRight /></button>) : <div className="dx-empty-cases"><Megaphone /><strong>You’re all caught up</strong><span>Official updates sent to your team will appear here.</span></div>}</div></div> : <>
      <section className={`dx-connect-channel-card ${confidential ? "speak-up" : "hr-help"}`}>
        <i>{confidential ? <ShieldCheck /> : <Headphones />}</i>
        <div><small>{confidential ? "CONFIDENTIAL CHANNEL" : "DIRECT PEOPLE SUPPORT"}</small><h2>{confidential ? "Speak Up" : "HR Help"}</h2><p>{channelSetting?.subtitle ?? (confidential ? "Report fraud, abuse, harassment or serious misconduct." : "Start a private conversation with People & Culture.")}</p></div>
        <button disabled={!channelSetting?.active} onClick={() => startCase(channel)}>{confidential ? "Report a concern" : "Start a conversation"}<ChevronRight /></button>
      </section>
      {confidential ? <div className="dx-anonymous-promise"><LockKeyhole /><div><strong>Your confidentiality promise</strong><p>Your report uses a case reference in the review workflow. Identity data is kept separately and access is restricted. Verified integrity reports may be considered for a reward under company policy.</p></div></div> : null}
      <div className="dx-my-cases-heading"><div><h2>{confidential ? "My Speak Up cases" : "My HR conversations"}</h2><p>Track progress and reply securely.</p></div><button aria-label="Refresh cases" onClick={() => void load(true)}><RefreshCw /></button></div>
      <div className="dx-my-cases">{channelCases.length ? channelCases.map((item) => <button key={item.id} onClick={() => setSelectedCaseId(item.id)}><i className={confidential ? "coral" : "violet"}>{confidential ? <ShieldCheck /> : <Headphones />}</i><span><small>{item.case_number} · {item.category}</small><strong>{item.subject}</strong><em>{shortDate(item.last_activity_at)}</em></span><b className={`dx-case-status ${item.status}`}>{statusLabels[item.status] ?? item.status}</b><ChevronRight /></button>) : <div className="dx-empty-cases"><MessageCircleMore /><strong>No conversations yet</strong><span>{confidential ? "Your confidential reports will appear here." : "Start a private conversation whenever you need HR support."}</span></div>}</div>
    </>}
  </section>;
}
