import { cookies } from "next/headers";
import Link from "next/link";
import {
  Archive, FileText, Forward, Inbox, Mail, MailOpen, Paperclip, Plus,
  RefreshCw, Reply, ReplyAll, Search, Send, Settings, Star, Trash2
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { renderMailSignature, type MailSenderProfile } from "@/lib/ops-pulse/location-mail";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  deleteMailDraftAction,
  saveMailDraftAction,
  saveMailSenderProfileAction,
  sendLocationMailAction,
  syncLocationMailboxAction,
  updateMailMessageAction
} from "./actions";

type StationRow = {
  station_code: string;
  station_manager_email: string | null;
  station_name: string | null;
};

type AddressRow = {
  id: string;
  station_id: string;
  email_address: string;
  is_active: boolean;
  route_state: string;
  stations: StationRow | StationRow[] | null;
};

type MailboxRow = {
  id: string;
  credential_email: string;
  display_name: string;
  status: string;
  sync_enabled: boolean;
  last_synced_at: string | null;
  last_sync_error: string | null;
  mailbox_mode: "individual" | "central_routed";
  ops_location_mailbox_addresses: AddressRow[] | null;
};

type MessageRow = {
  id: string;
  mailbox_id: string;
  station_id: string | null;
  google_message_id: string;
  google_thread_id: string;
  direction: "inbound" | "outbound";
  from_email: string;
  to_emails: string[];
  cc_emails: string[];
  bcc_emails: string[];
  subject: string;
  snippet: string;
  body_text: string | null;
  sent_at: string;
  is_read: boolean;
  label_ids: string[];
  metadata: Record<string, unknown> | null;
};

type DraftRow = {
  id: string;
  mailbox_id: string;
  mailbox_address_id: string;
  google_thread_id: string | null;
  in_reply_to: string | null;
  reference_ids: string | null;
  to_emails: string[];
  cc_emails: string[];
  bcc_emails: string[];
  subject: string;
  body_text: string;
  updated_at: string;
};

type SenderProfileRow = MailSenderProfile & { mailbox_address_id: string };
type ProfileContact = { email: string; full_name: string; mobile: string | null; mobile_country_code: string | null };
type Folder = "all" | "drafts" | "inbox" | "sent" | "starred" | "trash" | "unread";

const folderItems: Array<{ code: Folder; icon: typeof Inbox; label: string }> = [
  { code: "inbox", icon: Inbox, label: "Inbox" },
  { code: "starred", icon: Star, label: "Starred" },
  { code: "unread", icon: MailOpen, label: "Unread" },
  { code: "sent", icon: Send, label: "Sent" },
  { code: "drafts", icon: FileText, label: "Drafts" },
  { code: "all", icon: Mail, label: "All mail" },
  { code: "trash", icon: Trash2, label: "Trash" }
];

function first<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function flash() {
  const raw = cookies().get("dropx_location_mail_flash")?.value;
  if (!raw) return { error: null as string | null, notice: null as string | null };
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; notice?: unknown };
    return { error: typeof parsed.error === "string" ? parsed.error : null, notice: typeof parsed.notice === "string" ? parsed.notice : null };
  } catch {
    return { error: null, notice: null };
  }
}

function dateTime(value: string | null | undefined) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value));
}

function shortDate(value: string) {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }) === now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  return new Intl.DateTimeFormat("en-IN", sameDay ? { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" } : { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" }).format(date);
}

function schemaMissing(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("does not exist") || message.includes("schema cache") || ["42P01", "PGRST204", "PGRST205"].includes(String((error as { code?: unknown })?.code ?? ""));
}

function validFolder(value: string | undefined): Folder {
  return folderItems.some((item) => item.code === value) ? value as Folder : "inbox";
}

function hasLabel(row: MessageRow, label: string) {
  return (row.label_ids ?? []).includes(label);
}

function folderMatch(row: MessageRow, folder: Folder) {
  if (folder === "trash") return hasLabel(row, "TRASH");
  if (hasLabel(row, "TRASH")) return false;
  if (folder === "inbox") return hasLabel(row, "INBOX") || (row.direction === "inbound" && !hasLabel(row, "SENT"));
  if (folder === "sent") return hasLabel(row, "SENT") || row.direction === "outbound";
  if (folder === "starred") return hasLabel(row, "STARRED");
  if (folder === "unread") return !row.is_read;
  return true;
}

function initials(value: string) {
  const local = value.split("@")[0] ?? value;
  return local.split(/[._\s-]+/).map((part) => part[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "DX";
}

function mailHref(input: {
  compose?: boolean;
  draft?: string | null;
  folder: Folder;
  mode?: string | null;
  q?: string;
  settings?: boolean;
  station?: string | null;
  thread?: string | null;
}) {
  const params = new URLSearchParams({ folder: input.folder });
  if (input.station) params.set("station", input.station);
  if (input.thread) params.set("thread", input.thread);
  if (input.q) params.set("q", input.q);
  if (input.compose) params.set("compose", "1");
  if (input.draft) params.set("draft", input.draft);
  if (input.mode) params.set("mode", input.mode);
  if (input.settings) params.set("settings", "1");
  return `/mail?${params}`;
}

function attachmentRows(message: MessageRow) {
  const value = message.metadata?.attachments;
  return Array.isArray(value) ? value.filter((entry): entry is { attachmentId: string; filename: string; mimeType: string; size: number } =>
    Boolean(entry && typeof entry === "object" && "attachmentId" in entry && "filename" in entry)) : [];
}

function formatBytes(value: number) {
  if (!value) return "Attachment";
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export const dynamic = "force-dynamic";

export default async function MailPage({ searchParams }: { searchParams?: { compose?: string; draft?: string; folder?: string; mailbox?: string; mode?: string; q?: string; settings?: string; station?: string; thread?: string } }) {
  const authorization = await requirePagePermission("ops_location_mail", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.ops_location_mail;
  const message = flash();
  const folder = validFolder(searchParams?.folder);
  const search = String(searchParams?.q ?? "").trim();
  if (!supabaseAdmin) {
    return <AppShell active="Mail" pageCode="ops_location_mail"><section className="panel message-panel error"><div className="panel-body">Supabase service role key is not configured.</div></section></AppShell>;
  }

  const mailboxResult = await supabaseAdmin.from("ops_location_mailboxes")
    .select("id,credential_email,display_name,status,sync_enabled,last_synced_at,last_sync_error,mailbox_mode,ops_location_mailbox_addresses(id,station_id,email_address,is_active,route_state,stations(station_code,station_name,station_manager_email))")
    .eq("company_id", companyId).order("display_name");
  if (mailboxResult.error) {
    return <AppShell active="Mail" pageCode="ops_location_mail"><section className="panel message-panel error"><div className="panel-body"><strong>{schemaMissing(mailboxResult.error) ? "Mail setup pending" : "Unable to load Mail"}</strong><p className="subtle">{schemaMissing(mailboxResult.error) ? "Apply the OpsPulse Mail migration and configure a station sender." : mailboxResult.error.message}</p></div></section></AppShell>;
  }

  const mailboxes = (mailboxResult.data ?? []) as unknown as MailboxRow[];
  const eligibleMailboxes = mailboxes.map((mailbox) => ({
    ...mailbox,
    ops_location_mailbox_addresses: (mailbox.ops_location_mailbox_addresses ?? []).filter((address) =>
      address.is_active && (authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.locationScopeIds.includes(address.station_id)))
  })).filter((mailbox) => (mailbox.ops_location_mailbox_addresses ?? []).length > 0);
  const centralMailboxes = eligibleMailboxes.filter((mailbox) => mailbox.mailbox_mode === "central_routed" && mailbox.status !== "inactive");
  const centralStationIds = new Set(centralMailboxes.flatMap((mailbox) => (mailbox.ops_location_mailbox_addresses ?? [])
    .filter((address) => !["conflict", "error"].includes(address.route_state)).map((address) => address.station_id)));
  const scopedMailboxes = eligibleMailboxes.map((mailbox) => ({
    ...mailbox,
    ops_location_mailbox_addresses: (mailbox.ops_location_mailbox_addresses ?? []).filter((address) =>
      mailbox.mailbox_mode === "central_routed" ? !["conflict", "error"].includes(address.route_state) : !centralStationIds.has(address.station_id))
  })).filter((mailbox) => (mailbox.ops_location_mailbox_addresses ?? []).length > 0);
  const stationAddresses = scopedMailboxes.flatMap((mailbox) => (mailbox.ops_location_mailbox_addresses ?? []).map((address) => ({ address, mailbox })))
    .sort((left, right) => (first(left.address.stations)?.station_code ?? "").localeCompare(first(right.address.stations)?.station_code ?? ""));
  const selectedStation = stationAddresses.find((entry) => entry.address.id === searchParams?.station)
    ?? stationAddresses.find((entry) => entry.mailbox.id === searchParams?.mailbox) ?? stationAddresses[0] ?? null;
  const selectedMailbox = selectedStation?.mailbox ?? null;
  const selectedAddress = selectedStation?.address ?? null;
  const selectedLocation = first(selectedAddress?.stations);

  const managerEmails = Array.from(new Set(stationAddresses.map((entry) => first(entry.address.stations)?.station_manager_email?.trim().toLowerCase()).filter(Boolean))) as string[];
  const [messagesResult, draftsResult, senderProfilesResult, managerProfilesResult] = selectedMailbox && selectedAddress ? await Promise.all([
    supabaseAdmin.from("ops_location_mail_messages")
      .select("id,mailbox_id,station_id,google_message_id,google_thread_id,direction,from_email,to_emails,cc_emails,bcc_emails,subject,snippet,body_text,sent_at,is_read,label_ids,metadata")
      .eq("company_id", companyId).eq("mailbox_id", selectedMailbox.id).eq("station_id", selectedAddress.station_id)
      .order("sent_at", { ascending: false }).limit(1000),
    supabaseAdmin.from("ops_mail_drafts").select("id,mailbox_id,mailbox_address_id,google_thread_id,in_reply_to,reference_ids,to_emails,cc_emails,bcc_emails,subject,body_text,updated_at")
      .eq("company_id", companyId).eq("mailbox_address_id", selectedAddress.id).order("updated_at", { ascending: false }),
    supabaseAdmin.from("ops_mail_sender_profiles").select("mailbox_address_id,sender_display_name,station_label,contact_name,contact_title,contact_mobile,logo_url,accent_color,signature_enabled")
      .eq("company_id", companyId),
    managerEmails.length
      ? supabaseAdmin.from("profiles").select("email,full_name,mobile_country_code,mobile").eq("company_id", companyId).in("email", managerEmails)
      : Promise.resolve({ data: [] as ProfileContact[], error: null })
  ]) : [{ data: [] as MessageRow[], error: null }, { data: [] as DraftRow[], error: null }, { data: [] as SenderProfileRow[], error: null }, { data: [] as ProfileContact[], error: null }];

  const rows = (messagesResult.data ?? []) as MessageRow[];
  const drafts = (draftsResult.data ?? []) as DraftRow[];
  const profiles = (senderProfilesResult.data ?? []) as SenderProfileRow[];
  const managerProfiles = (managerProfilesResult.data ?? []) as ProfileContact[];
  const manager = managerProfiles.find((profile) => profile.email.toLowerCase() === selectedLocation?.station_manager_email?.toLowerCase());
  const senderProfile = profiles.find((profile) => profile.mailbox_address_id === selectedAddress?.id) ?? ({
    mailbox_address_id: selectedAddress?.id ?? "",
    sender_display_name: `${selectedLocation?.station_code ?? "Station"} DropX Logistics`,
    station_label: `${selectedLocation?.station_code ?? "Station"} · ${selectedLocation?.station_name ?? "Station"}`,
    contact_name: manager?.full_name ?? "",
    contact_title: "Team Leader",
    contact_mobile: [
      manager?.mobile_country_code
        ? manager.mobile_country_code.startsWith("+")
          ? manager.mobile_country_code
          : `+${manager.mobile_country_code}`
        : null,
      manager?.mobile,
    ].filter(Boolean).join(" "),
    logo_url: "https://ops.dropxlogistics.com/dropx-logo.png",
    accent_color: "#ef6c00",
    signature_enabled: true
  } satisfies SenderProfileRow);
  const signature = renderMailSignature(senderProfile);
  const normalizedSearch = search.toLowerCase();
  const visibleRows = rows.filter((row) => folderMatch(row, folder)).filter((row) => !normalizedSearch || [row.subject, row.from_email, row.to_emails.join(" "), row.cc_emails.join(" "), row.snippet, row.body_text].join(" ").toLowerCase().includes(normalizedSearch));
  const threadMap = new Map<string, { latest: MessageRow; messages: MessageRow[]; unread: number }>();
  for (const row of visibleRows) {
    const existing = threadMap.get(row.google_thread_id);
    if (!existing) threadMap.set(row.google_thread_id, { latest: row, messages: [row], unread: row.is_read ? 0 : 1 });
    else {
      existing.messages.push(row);
      if (!row.is_read) existing.unread += 1;
      if (new Date(row.sent_at).getTime() > new Date(existing.latest.sent_at).getTime()) existing.latest = row;
    }
  }
  const threads = Array.from(threadMap.values()).sort((a, b) => new Date(b.latest.sent_at).getTime() - new Date(a.latest.sent_at).getTime());
  const selectedThread = (searchParams?.thread ? threadMap.get(searchParams.thread) : null) ?? (folder === "drafts" ? null : threads[0] ?? null);
  const threadMessages = [...(selectedThread?.messages ?? [])].sort((a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime());
  const lastThreadMessage = threadMessages.at(-1) ?? null;
  const selectedDraft = drafts.find((draft) => draft.id === searchParams?.draft) ?? (folder === "drafts" ? drafts[0] ?? null : null);
  const mode = searchParams?.mode ?? "";
  const showCompose = searchParams?.compose === "1" || Boolean(selectedDraft) || Boolean(mode);
  const stationEmail = selectedAddress?.email_address ?? "";
  const replyAll = lastThreadMessage
    ? Array.from(new Set([lastThreadMessage.from_email, ...lastThreadMessage.to_emails, ...lastThreadMessage.cc_emails].filter((email) => email && email.toLowerCase() !== stationEmail.toLowerCase())))
    : [];
  const composeTo = selectedDraft?.to_emails.join(", ") ?? (mode === "reply_all" ? replyAll.join(", ") : mode === "reply" ? (lastThreadMessage?.direction === "inbound" ? lastThreadMessage.from_email : lastThreadMessage?.to_emails[0] ?? "") : "");
  const composeCc = selectedDraft?.cc_emails.join(", ") ?? (mode === "reply_all" ? lastThreadMessage?.cc_emails.filter((email) => email.toLowerCase() !== stationEmail.toLowerCase()).join(", ") ?? "" : "");
  const baseSubject = selectedDraft?.subject ?? selectedThread?.latest.subject ?? "";
  const composeSubject = selectedDraft ? baseSubject : mode === "forward" ? (baseSubject.toLowerCase().startsWith("fwd:") ? baseSubject : `Fwd: ${baseSubject}`) : mode ? (baseSubject.toLowerCase().startsWith("re:") ? baseSubject : `Re: ${baseSubject}`) : "";
  const composeBody = selectedDraft?.body_text ?? (mode === "forward" && lastThreadMessage ? `\n\n---------- Forwarded message ----------\nFrom: ${lastThreadMessage.from_email}\nDate: ${dateTime(lastThreadMessage.sent_at)}\nSubject: ${lastThreadMessage.subject}\nTo: ${lastThreadMessage.to_emails.join(", ")}\n\n${lastThreadMessage.body_text || lastThreadMessage.snippet}` : "");
  const references = String(selectedDraft?.reference_ids ?? lastThreadMessage?.metadata?.references ?? lastThreadMessage?.metadata?.message_id ?? "");
  const inboxUnread = rows.filter((row) => folderMatch(row, "inbox") && !row.is_read).length;
  const folderCounts: Record<Folder, number> = {
    inbox: inboxUnread,
    starred: rows.filter((row) => folderMatch(row, "starred")).length,
    unread: rows.filter((row) => folderMatch(row, "unread")).length,
    sent: rows.filter((row) => folderMatch(row, "sent")).length,
    drafts: drafts.length,
    all: rows.filter((row) => folderMatch(row, "all")).length,
    trash: rows.filter((row) => folderMatch(row, "trash")).length
  };
  const selectedRouteReady = Boolean(selectedAddress && ["active", "not_required"].includes(selectedAddress.route_state));

  return (
    <AppShell active="Mail" pageCode="ops_location_mail">
      <section className="ops-mail-app">
        <header className="ops-mail-header">
          <div className="ops-mail-title"><span><Mail size={22} /></span><div><h1>Mail</h1><p>Shared DropX email, routed by station</p></div></div>
          <form className="ops-mail-search" method="get">
            <Search size={18} />
            <input aria-label="Search mail" defaultValue={search} name="q" placeholder="Search mail" />
            <input name="folder" type="hidden" value={folder} />
            <input name="station" type="hidden" value={selectedAddress?.id ?? ""} />
          </form>
          <div className="ops-mail-header-actions"><StatusPill status={`${stationAddresses.length} station address${stationAddresses.length === 1 ? "" : "es"}`} /></div>
        </header>

        {message.error || message.notice ? <div className={`ops-mail-flash ${message.error ? "error" : "success"}`}><strong>{message.error ? "Action required" : "Completed"}</strong><span>{message.error ?? message.notice}</span></div> : null}
        {messagesResult.error || draftsResult.error || senderProfilesResult.error ? <div className="ops-mail-flash error">{messagesResult.error?.message ?? draftsResult.error?.message ?? senderProfilesResult.error?.message}</div> : null}

        {!stationAddresses.length ? <div className="empty-cell"><strong>No Mail sender is configured for your station scope.</strong><br />A Super Admin can configure the central mailbox pilot in the Main Dashboard.</div> : (
          <div className="ops-mail-grid">
            <aside className="ops-mail-rail">
              <Link className="ops-mail-compose-button" href={mailHref({ compose: true, folder, q: search, station: selectedAddress?.id })}><Plus size={19} /> Compose</Link>
              <nav aria-label="Mail folders">
                {folderItems.map((item) => { const Icon = item.icon; return <Link className={folder === item.code && searchParams?.settings !== "1" ? "active" : ""} href={mailHref({ folder: item.code, station: selectedAddress?.id })} key={item.code}><Icon size={17} /><span>{item.label}</span>{folderCounts[item.code] ? <b>{folderCounts[item.code]}</b> : null}</Link>; })}
              </nav>
              <div className="ops-mail-rail-divider" />
              <Link className={searchParams?.settings === "1" ? "active" : ""} href={mailHref({ folder, settings: true, station: selectedAddress?.id })}><Settings size={17} /><span>Signature & sender</span></Link>
              <div className="ops-mail-account-card"><strong>{senderProfile.sender_display_name}</strong><span>{stationEmail}</span><small>Powered by {selectedMailbox?.credential_email}</small></div>
            </aside>

            <main className="ops-mail-main">
              <div className="ops-mail-toolbar">
                <form method="get" className="ops-mail-station-picker">
                  <input name="folder" type="hidden" value={folder} />
                  <select aria-label="Station sender" defaultValue={selectedAddress?.id} name="station">{stationAddresses.map(({ address }) => { const station = first(address.stations); return <option key={address.id} value={address.id}>{station?.station_code ?? "Station"} · {station?.station_name ?? "Station"} · {address.email_address}</option>; })}</select>
                  <button type="submit">Open</button>
                </form>
                <span className="ops-mail-sync-time">Synced {dateTime(selectedMailbox?.last_synced_at)}</span>
                <form action={syncLocationMailboxAction}><input name="mailbox_id" type="hidden" value={selectedMailbox?.id} /><SubmitButton className="ops-mail-icon-button" disabled={!selectedMailbox?.sync_enabled} pendingText="…"><RefreshCw size={17} /><span className="sr-only">Sync Google mail</span></SubmitButton></form>
              </div>

              {!selectedRouteReady ? <div className="ops-mail-flash warning"><strong>{stationEmail} is not ready for outbound mail.</strong><span>Google route state: {selectedAddress?.route_state ?? "pending"}</span></div> : null}

              {searchParams?.settings === "1" ? (
                <section className="ops-mail-settings-page">
                  <div className="ops-mail-section-head"><div><h2>Sender identity & signature</h2><p>Values are sourced from Station Master and the assigned TL profile. Override them here when needed.</p></div><StatusPill status={stationEmail} /></div>
                  <div className="ops-mail-settings-grid">
                    <form action={saveMailSenderProfileAction} className="ops-mail-settings-form">
                      <input name="mailbox_id" type="hidden" value={selectedMailbox?.id} />
                      <input name="station_address_id" type="hidden" value={selectedAddress?.id} />
                      <label>Sender name<input defaultValue={senderProfile.sender_display_name} name="sender_display_name" required /><small>Recipients see this instead of the raw email address.</small></label>
                      <label>Station name<input defaultValue={senderProfile.station_label} name="station_label" required /></label>
                      <div className="ops-mail-two-fields"><label>TL name<input defaultValue={senderProfile.contact_name} name="contact_name" required /></label><label>Role<input defaultValue={senderProfile.contact_title} name="contact_title" required /></label></div>
                      <label>TL mobile number<input defaultValue={senderProfile.contact_mobile} name="contact_mobile" required /></label>
                      <label>DropX logo URL<input defaultValue={senderProfile.logo_url} name="logo_url" placeholder="https://…/dropx-logo.png" type="url" /></label>
                      <label>Signature accent colour<input defaultValue={senderProfile.accent_color} name="accent_color" pattern="#[0-9A-Fa-f]{6}" type="color" /></label>
                      <label className="ops-mail-checkbox"><input defaultChecked={senderProfile.signature_enabled} name="signature_enabled" type="checkbox" value="true" /> Add this signature automatically</label>
                      <SubmitButton pendingText="Saving sender…">Save sender & signature</SubmitButton>
                    </form>
                    <div className="ops-mail-signature-preview"><span>Recipient preview</span><div className="ops-mail-preview-message"><header><div className="ops-mail-avatar">{initials(senderProfile.sender_display_name)}</div><div><strong>{senderProfile.sender_display_name}</strong><small>{stationEmail}</small></div></header><p>Hello,</p><p>Your operational update will appear here.</p><div dangerouslySetInnerHTML={{ __html: signature.html }} /></div></div>
                  </div>
                </section>
              ) : (
                <div className="ops-mail-content-grid">
                  <section className="ops-mail-list">
                    <div className="ops-mail-list-head"><div><h2>{folderItems.find((item) => item.code === folder)?.label}</h2><span>{folder === "drafts" ? drafts.length : threads.length} {folder === "drafts" ? "drafts" : "conversations"}</span></div>{search ? <small>Results for “{search}”</small> : null}</div>
                    <div className="ops-mail-list-items">
                      {folder === "drafts" ? drafts.map((draft) => <Link className={`ops-mail-row draft ${draft.id === selectedDraft?.id ? "active" : ""}`} href={mailHref({ draft: draft.id, folder, station: selectedAddress?.id })} key={draft.id}><Star size={16} /><div><strong>{draft.subject || "(No subject)"}</strong><span>{draft.to_emails.length ? `To: ${draft.to_emails.join(", ")}` : "No recipient"}</span><small>{draft.body_text || "Empty draft"}</small></div><time>{shortDate(draft.updated_at)}</time></Link>) : threads.map((thread) => <Link className={`ops-mail-row ${thread.unread ? "unread" : ""} ${thread.latest.google_thread_id === selectedThread?.latest.google_thread_id ? "active" : ""}`} href={mailHref({ folder, q: search, station: selectedAddress?.id, thread: thread.latest.google_thread_id })} key={thread.latest.google_thread_id}><Star className={hasLabel(thread.latest, "STARRED") ? "filled" : ""} size={16} /><div><strong>{thread.latest.direction === "inbound" ? thread.latest.from_email : `To: ${thread.latest.to_emails.join(", ")}`}</strong><span>{thread.latest.subject || "(No subject)"}</span><small>{thread.latest.snippet || thread.latest.body_text}</small></div><time>{shortDate(thread.latest.sent_at)}</time></Link>)}
                      {folder === "drafts" && !drafts.length ? <div className="ops-mail-empty">No saved drafts.</div> : null}
                      {folder !== "drafts" && !threads.length ? <div className="ops-mail-empty">{search ? "No matching mail." : `No messages in ${folder}.`}</div> : null}
                    </div>
                  </section>

                  <section className="ops-mail-reading-pane">
                    {showCompose ? (
                      <form action={sendLocationMailAction} className="ops-mail-composer">
                        <input name="mailbox_id" type="hidden" value={selectedMailbox?.id} />
                        <input name="station_address_id" type="hidden" value={selectedAddress?.id} />
                        <input name="draft_id" type="hidden" value={selectedDraft?.id ?? ""} />
                        <input name="thread_id" type="hidden" value={selectedDraft?.google_thread_id ?? (mode && selectedThread ? selectedThread.latest.google_thread_id : "")} />
                        <input name="in_reply_to" type="hidden" value={selectedDraft?.in_reply_to ?? String(lastThreadMessage?.metadata?.message_id ?? "")} />
                        <input name="references" type="hidden" value={references} />
                        <header><div><h2>{selectedDraft ? "Edit draft" : mode ? (mode === "forward" ? "Forward" : "Reply") : "New message"}</h2><span>From {senderProfile.sender_display_name} &lt;{stationEmail}&gt;</span></div><Link aria-label="Close composer" href={mailHref({ folder, station: selectedAddress?.id, thread: selectedThread?.latest.google_thread_id })}>×</Link></header>
                        <div className="ops-mail-recipient-line"><label>To</label><input defaultValue={composeTo} name="to" placeholder="Recipients" /></div>
                        <div className="ops-mail-recipient-line"><label>Cc</label><input defaultValue={composeCc} name="cc" placeholder="CC recipients" /></div>
                        <div className="ops-mail-recipient-line"><label>Bcc</label><input defaultValue={selectedDraft?.bcc_emails.join(", ") ?? ""} name="bcc" placeholder="BCC recipients" /></div>
                        <input className="ops-mail-subject" defaultValue={composeSubject} name="subject" placeholder="Subject" required />
                        <textarea autoFocus className="ops-mail-body" defaultValue={composeBody} name="body" placeholder="Write your message" required />
                        <div className="ops-mail-signature-chip"><strong>Signature</strong><span>{senderProfile.station_label} · {senderProfile.contact_name || "TL not mapped"} · {senderProfile.contact_mobile || "mobile not mapped"}</span></div>
                        <div className="ops-mail-attachment-field"><Paperclip size={17} /><label>Attach files<input multiple name="attachments" type="file" /></label><small>Up to 10 files · 20 MB total</small></div>
                        <footer><SubmitButton disabled={!selectedRouteReady} pendingText="Sending…">Send</SubmitButton><button className="ops-mail-secondary-button" formAction={saveMailDraftAction} type="submit">Save draft</button>{selectedDraft ? <button className="ops-mail-danger-button" formAction={deleteMailDraftAction} type="submit"><Trash2 size={16} /> Delete draft</button> : null}</footer>
                      </form>
                    ) : selectedThread ? (
                      <div className="ops-mail-thread-view">
                        <header className="ops-mail-thread-head"><div><h2>{selectedThread.latest.subject || "(No subject)"}</h2><span>{threadMessages.length} message{threadMessages.length === 1 ? "" : "s"}</span></div><div className="ops-mail-thread-actions"><form action={updateMailMessageAction}><input name="mailbox_id" type="hidden" value={selectedMailbox?.id} /><input name="station_address_id" type="hidden" value={selectedAddress?.id} /><input name="message_id" type="hidden" value={selectedThread.latest.id} /><input name="folder" type="hidden" value={folder} /><button name="mail_action" title={hasLabel(selectedThread.latest, "STARRED") ? "Remove star" : "Star"} value={hasLabel(selectedThread.latest, "STARRED") ? "unstar" : "star"}><Star className={hasLabel(selectedThread.latest, "STARRED") ? "filled" : ""} size={17} /></button><button name="mail_action" title="Archive" value="archive"><Archive size={17} /></button><button name="mail_action" title={selectedThread.latest.is_read ? "Mark unread" : "Mark read"} value={selectedThread.latest.is_read ? "mark_unread" : "mark_read"}><MailOpen size={17} /></button><button name="mail_action" title={folder === "trash" ? "Restore" : "Move to trash"} value={folder === "trash" ? "untrash" : "trash"}><Trash2 size={17} /></button></form></div></header>
                        <div className="ops-mail-messages">{threadMessages.map((entry) => <article key={entry.id}><header><div className="ops-mail-avatar">{initials(entry.direction === "outbound" ? senderProfile.sender_display_name : entry.from_email)}</div><div><strong>{entry.direction === "outbound" ? senderProfile.sender_display_name : entry.from_email}</strong><small>to {entry.to_emails.join(", ")}{entry.cc_emails.length ? ` · cc ${entry.cc_emails.join(", ")}` : ""}</small></div><time>{dateTime(entry.sent_at)}</time></header><pre>{entry.body_text || entry.snippet || "(No text body)"}</pre>{attachmentRows(entry).length ? <div className="ops-mail-attachments">{attachmentRows(entry).map((attachment) => <a href={`/api/ops-pulse/mail/attachments/${entry.id}/${encodeURIComponent(attachment.attachmentId)}?mailbox=${selectedMailbox?.id}`} key={attachment.attachmentId}><Paperclip size={15} /><span><strong>{attachment.filename}</strong><small>{formatBytes(attachment.size)}</small></span></a>)}</div> : null}</article>)}</div>
                        <div className="ops-mail-reply-actions"><Link href={mailHref({ folder, mode: "reply", station: selectedAddress?.id, thread: selectedThread.latest.google_thread_id })}><Reply size={16} /> Reply</Link><Link href={mailHref({ folder, mode: "reply_all", station: selectedAddress?.id, thread: selectedThread.latest.google_thread_id })}><ReplyAll size={16} /> Reply all</Link><Link href={mailHref({ folder, mode: "forward", station: selectedAddress?.id, thread: selectedThread.latest.google_thread_id })}><Forward size={16} /> Forward</Link></div>
                      </div>
                    ) : <div className="ops-mail-empty large"><Mail size={42} /><strong>Select a message or compose a new email</strong><span>Mail will be sent as {senderProfile.sender_display_name}.</span></div>}
                  </section>
                </div>
              )}
            </main>
          </div>
        )}
      </section>
    </AppShell>
  );
}
