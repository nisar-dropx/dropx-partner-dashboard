import { cookies } from "next/headers";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { sendLocationMailAction, syncLocationMailboxAction } from "./actions";

type AddressRow = {
  station_id: string;
  email_address: string;
  is_active: boolean;
  stations: { station_code: string; station_name: string | null } | Array<{ station_code: string; station_name: string | null }> | null;
};

type MailboxRow = {
  id: string;
  credential_email: string;
  display_name: string;
  status: string;
  sync_enabled: boolean;
  last_synced_at: string | null;
  last_sync_error: string | null;
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
  subject: string;
  snippet: string;
  body_text: string | null;
  sent_at: string;
  is_read: boolean;
  metadata: Record<string, unknown> | null;
};

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

function schemaMissing(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("does not exist") || message.includes("schema cache") || ["42P01", "PGRST204", "PGRST205"].includes(String((error as { code?: unknown })?.code ?? ""));
}

export const dynamic = "force-dynamic";

export default async function LocationMailPage({ searchParams }: { searchParams?: { mailbox?: string; thread?: string } }) {
  const authorization = await requirePagePermission("ops_location_mail", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.ops_location_mail;
  const message = flash();
  if (!supabaseAdmin) {
    return <AppShell active="Location Mail" pageCode="ops_location_mail"><PageHead eyebrow="Ops Pulse" title="Location Mail" subtitle="One governed inbox for station email." /><section className="panel message-panel error"><div className="panel-body">Supabase service role key is not configured.</div></section></AppShell>;
  }

  const mailboxResult = await supabaseAdmin.from("ops_location_mailboxes")
    .select("id,credential_email,display_name,status,sync_enabled,last_synced_at,last_sync_error,ops_location_mailbox_addresses(station_id,email_address,is_active,stations(station_code,station_name))")
    .eq("company_id", companyId).order("display_name");
  if (mailboxResult.error) {
    return <AppShell active="Location Mail" pageCode="ops_location_mail"><PageHead eyebrow="Ops Pulse" title="Location Mail" subtitle="One governed inbox for station email." /><section className="panel message-panel error"><div className="panel-body"><strong>{schemaMissing(mailboxResult.error) ? "Mailbox setup pending" : "Unable to load mailboxes"}</strong><p className="subtle">{schemaMissing(mailboxResult.error) ? "Apply the location-mail migration, then map a Google mail ID to a location in the main dashboard." : mailboxResult.error.message}</p></div></section></AppShell>;
  }

  const mailboxes = (mailboxResult.data ?? []) as unknown as MailboxRow[];
  const scopedMailboxes = mailboxes.map((mailbox) => ({
    ...mailbox,
    ops_location_mailbox_addresses: (mailbox.ops_location_mailbox_addresses ?? []).filter((address) =>
      address.is_active && (authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.locationScopeIds.includes(address.station_id)))
  })).filter((mailbox) => (mailbox.ops_location_mailbox_addresses ?? []).length > 0);
  const selectedMailbox = scopedMailboxes.find((mailbox) => mailbox.id === searchParams?.mailbox) ?? scopedMailboxes[0] ?? null;
  const stationIds = selectedMailbox?.ops_location_mailbox_addresses?.map((address) => address.station_id) ?? [];
  const messagesResult = selectedMailbox
    ? await supabaseAdmin.from("ops_location_mail_messages").select("id,mailbox_id,station_id,google_message_id,google_thread_id,direction,from_email,to_emails,cc_emails,subject,snippet,body_text,sent_at,is_read,metadata")
      .eq("company_id", companyId).eq("mailbox_id", selectedMailbox.id).in("station_id", stationIds.length ? stationIds : ["00000000-0000-0000-0000-000000000000"])
      .order("sent_at", { ascending: false }).limit(500)
    : { data: [] as MessageRow[], error: null };
  const rows = (messagesResult.data ?? []) as MessageRow[];
  const threadMap = new Map<string, { latest: MessageRow; messages: MessageRow[]; unread: number }>();
  for (const row of rows) {
    const existing = threadMap.get(row.google_thread_id);
    if (!existing) threadMap.set(row.google_thread_id, { latest: row, messages: [row], unread: row.is_read ? 0 : 1 });
    else {
      existing.messages.push(row);
      if (!row.is_read) existing.unread += 1;
      if (new Date(row.sent_at).getTime() > new Date(existing.latest.sent_at).getTime()) existing.latest = row;
    }
  }
  const threads = Array.from(threadMap.values()).sort((a, b) => new Date(b.latest.sent_at).getTime() - new Date(a.latest.sent_at).getTime());
  const selectedThread = (searchParams?.thread ? threadMap.get(searchParams.thread) : null) ?? threads[0] ?? null;
  const threadMessages = [...(selectedThread?.messages ?? [])].sort((a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime());
  const lastThreadMessage = threadMessages.at(-1) ?? null;
  const replyTo = lastThreadMessage?.direction === "inbound" ? lastThreadMessage.from_email : lastThreadMessage?.to_emails?.[0] ?? "";
  const references = String(lastThreadMessage?.metadata?.references ?? lastThreadMessage?.metadata?.message_id ?? "");

  return (
    <AppShell active="Location Mail" pageCode="ops_location_mail">
      <PageHead eyebrow="Ops Pulse" title="Location Mail" subtitle="Station-scoped Google mail, threads, replies and CC history in one operational inbox." action={<StatusPill status={`${scopedMailboxes.length} mailbox${scopedMailboxes.length === 1 ? "" : "es"}`} />} />
      {message.error || message.notice ? <section className={`panel message-panel ${message.error ? "error" : "success"}`}><div className="panel-body"><strong>{message.error ? "Action required" : "Completed"}</strong><p className="subtle">{message.error ?? message.notice}</p></div></section> : null}
      {messagesResult.error ? <section className="panel message-panel error"><div className="panel-body">{messagesResult.error.message}</div></section> : null}
      {!scopedMailboxes.length ? (
        <section className="panel"><div className="empty-cell"><strong>No location mailbox is mapped for your station scope.</strong><br />A Super Admin can map an existing Google mail ID to a station under Main Dashboard → Central Identity → Google Mail IDs &amp; Mapping.</div></section>
      ) : (
        <>
          <section className="panel location-mail-toolbar">
            <div className="panel-body location-mail-toolbar-grid">
              <form method="get"><label>Station mailbox<select className="field" defaultValue={selectedMailbox?.id} name="mailbox">{scopedMailboxes.map((mailbox) => <option key={mailbox.id} value={mailbox.id}>{mailbox.display_name} · {mailbox.credential_email}</option>)}</select></label><button className="button secondary compact" type="submit">Open</button></form>
              <div><span className="subtle">Last Google sync</span><strong>{dateTime(selectedMailbox?.last_synced_at)}</strong>{selectedMailbox?.last_sync_error ? <small className="metric-bad-text">{selectedMailbox.last_sync_error}</small> : null}</div>
              <form action={syncLocationMailboxAction}><input name="mailbox_id" type="hidden" value={selectedMailbox?.id} /><SubmitButton className="button secondary" disabled={!selectedMailbox?.sync_enabled} pendingText="Syncing...">Sync Google mail</SubmitButton></form>
            </div>
          </section>

          <div className="location-mail-layout">
            <section className="panel location-mail-thread-list">
              <div className="panel-head"><div><h2>Inbox</h2><p className="subtle">{threads.length} conversation{threads.length === 1 ? "" : "s"}</p></div></div>
              <div className="location-mail-thread-items">
                {threads.map((thread) => <Link className={`location-mail-thread ${thread.latest.google_thread_id === selectedThread?.latest.google_thread_id ? "active" : ""}`} href={`/mail?mailbox=${selectedMailbox?.id}&thread=${thread.latest.google_thread_id}`} key={thread.latest.google_thread_id}><span><strong>{thread.latest.subject}</strong><small>{thread.latest.direction === "inbound" ? thread.latest.from_email : `To: ${thread.latest.to_emails.join(", ")}`}</small><small>{thread.latest.snippet}</small></span><span><time>{dateTime(thread.latest.sent_at)}</time>{thread.unread ? <b>{thread.unread}</b> : null}</span></Link>)}
                {!threads.length ? <div className="empty-cell">Sync this mailbox to load recent Google conversations.</div> : null}
              </div>
            </section>

            <section className="panel location-mail-conversation">
              <div className="panel-head"><div><h2>{selectedThread?.latest.subject ?? "New email"}</h2><p className="subtle">Sent and received as {selectedMailbox?.credential_email}</p></div></div>
              {threadMessages.length ? <div className="location-mail-messages">{threadMessages.map((entry) => <article className={`location-mail-message ${entry.direction}`} key={entry.id}><header><span><strong>{entry.direction === "inbound" ? entry.from_email : selectedMailbox?.credential_email}</strong><small>To: {entry.to_emails.join(", ")}{entry.cc_emails.length ? ` · CC: ${entry.cc_emails.join(", ")}` : ""}</small></span><time>{dateTime(entry.sent_at)}</time></header><pre>{entry.body_text || entry.snippet || "(No text body)"}</pre></article>)}</div> : <div className="empty-cell">Choose a thread or compose the first station email.</div>}

              {permission?.canEdit ? <form action={sendLocationMailAction} className="location-mail-compose">
                <input name="mailbox_id" type="hidden" value={selectedMailbox?.id} />
                <input name="thread_id" type="hidden" value={selectedThread?.latest.google_thread_id ?? ""} />
                <input name="in_reply_to" type="hidden" value={String(lastThreadMessage?.metadata?.message_id ?? "")} />
                <input name="references" type="hidden" value={references} />
                <h3>{selectedThread ? "Reply" : "Compose"}</h3>
                <div className="form-grid two"><label>To<input className="field" defaultValue={replyTo} name="to" placeholder="recipient@example.com" required /></label><label>CC<input className="field" name="cc" placeholder="manager@example.com" /></label></div>
                <label>Subject<input className="field" defaultValue={selectedThread ? (selectedThread.latest.subject.toLowerCase().startsWith("re:") ? selectedThread.latest.subject : `Re: ${selectedThread.latest.subject}`) : ""} name="subject" required /></label>
                <label>Message<textarea className="textarea" name="body" placeholder="Write a station response" required rows={7} /></label>
                <div className="form-actions"><SubmitButton pendingText="Sending...">Send as {selectedMailbox?.credential_email}</SubmitButton></div>
              </form> : null}
            </section>
          </div>
        </>
      )}
    </AppShell>
  );
}
