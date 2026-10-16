"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Bot, Camera, FileText, Image as ImageIcon, Loader2, MapPin, Mic, RefreshCw, Search, Users, Video, WifiOff } from "lucide-react";
import s from "@/app/ops-pulse/report-bot/report-bot.module.css";
import { ImageModal } from "@/components/report-bot-image-viewer";

type ChatGroup = { id: string; name: string; size: number | null; preview: string | null; lastAt: string | null };
type Quoted = { id: string; from: string | null; type: string; text: string | null };
type Message = {
  id: string; from: string | null; name: string | null; from_me: boolean; bot: boolean; ts: number; type: string; text: string | null;
  quoted: Quoted | null; mentions: string[];
  report: { submission_id: string; verdict: string | null; status: string; has_image: boolean } | null;
  kind: string | null;
};
type ChatPayload = {
  group: { id: string; name: string; size: number | null; enabled: boolean };
  live: boolean; connected: boolean; since: number | null; notice: string | null;
  names: Record<string, string>; messages: Message[];
};

const POLL_MS = 5000;
// WhatsApp-like sender colours, chosen for contrast on a white bubble.
const NAME_COLOURS = ["#1f7aec", "#c0392b", "#8e44ad", "#16a085", "#d35400", "#2c3e50", "#b7287d", "#2e7d32", "#6d4c41", "#00838f"];
const VERDICT: Record<string, { label: string; tone: string }> = {
  pass: { label: "Report looks good", tone: s.good },
  fail: { label: "Report needs correction", tone: s.bad },
  needs_review: { label: "Report unclear", tone: s.warn },
  not_report: { label: "Not a report", tone: s.neutral }
};
const KIND: Record<string, string> = { reminder: "Reminder", followup: "Follow-up", overdue: "Overdue notice", feedback: "Review reply" };

function colourFor(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return NAME_COLOURS[Math.abs(hash) % NAME_COLOURS.length];
}

function bare(jid: string | null) {
  return String(jid ?? "").split("@")[0].split(":")[0];
}

function displayName(jid: string | null, fallback: string | null, names: Record<string, string>) {
  if (fallback) return fallback;
  if (jid && names[jid]) return names[jid];
  const digits = bare(jid);
  return digits ? `+${digits}` : "Member";
}

function nameForMention(digits: string, names: Record<string, string>) {
  return names[`${digits}@s.whatsapp.net`] ?? names[`${digits}@lid`] ?? null;
}

/** WhatsApp formatting (*bold*, _italic_, ~strike~) and @mentions, rendered as React nodes (never HTML). */
function RichText({ text, names }: { text: string; names: Record<string, string> }) {
  const parts = text.split(/(@\d{5,20}|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (/^@\d{5,20}$/.test(part)) {
          const name = nameForMention(part.slice(1), names);
          return <span key={index} className={s.mention}>@{name ?? `+${part.slice(1)}`}</span>;
        }
        if (/^\*[^*\n]+\*$/.test(part)) return <strong key={index}>{part.slice(1, -1)}</strong>;
        if (/^_[^_\n]+_$/.test(part)) return <em key={index}>{part.slice(1, -1)}</em>;
        if (/^~[^~\n]+~$/.test(part)) return <s key={index}>{part.slice(1, -1)}</s>;
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}

function mediaLabel(type: string, text: string | null): { icon: ReactNode; label: string } {
  switch (type) {
    case "image": return { icon: <Camera size={14} aria-hidden />, label: "Photo" };
    case "video": return { icon: <Video size={14} aria-hidden />, label: "Video" };
    case "audio": return { icon: <Mic size={14} aria-hidden />, label: "Voice message" };
    case "document": return { icon: <FileText size={14} aria-hidden />, label: text || "Document" };
    case "sticker": return { icon: <ImageIcon size={14} aria-hidden />, label: "Sticker" };
    case "location": return { icon: <MapPin size={14} aria-hidden />, label: "Location" };
    case "poll": return { icon: <FileText size={14} aria-hidden />, label: `Poll: ${text ?? ""}` };
    case "contact": return { icon: <Users size={14} aria-hidden />, label: "Contact card" };
    default: return { icon: null, label: "" };
  }
}

function dayLabel(ts: number) {
  const date = new Date(ts * 1000);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" });
}

function clock(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

function Bubble({ message, names, onOpenImage, byId }: { message: Message; names: Record<string, string>; onOpenImage: (id: string, title: string) => void; byId: Map<string, Message> }) {
  const outgoing = message.from_me;
  const sender = displayName(message.from, message.name, names);
  const media = mediaLabel(message.type, message.text);
  const verdict = message.report?.verdict ? VERDICT[message.report.verdict] : null;
  const quotedSource = message.quoted ? byId.get(message.quoted.id) : null;
  const quotedName = message.quoted
    ? quotedSource?.from_me ? (quotedSource.bot ? "Report Bot" : "You") : displayName(message.quoted.from, quotedSource?.name ?? null, names)
    : "";
  const caption = message.type === "document" ? null : message.text;
  return (
    <div className={`${s.chatRow} ${outgoing ? s.chatRowOut : ""}`}>
      <div className={`${s.bubble} ${outgoing ? s.bubbleOut : ""}`}>
        {outgoing ? (
          message.bot ? <span className={s.botTag}><Bot size={12} aria-hidden />Report Bot{message.kind ? ` · ${KIND[message.kind] ?? message.kind}` : ""}</span> : null
        ) : <span className={s.senderName} style={{ color: colourFor(message.from ?? sender) }}>{sender}</span>}
        {message.quoted ? (
          <div className={s.quote} style={{ borderLeftColor: colourFor(message.quoted.from ?? quotedName) }}>
            <strong style={{ color: colourFor(message.quoted.from ?? quotedName) }}>{quotedName}</strong>
            <span>{message.quoted.type === "image" ? <><Camera size={12} aria-hidden /> {message.quoted.text || "Photo"}</> : message.quoted.text || mediaLabel(message.quoted.type, null).label}</span>
          </div>
        ) : null}
        {message.type === "image" ? (
          message.report?.has_image ? (
            <button type="button" className={s.chatImage} onClick={() => onOpenImage(message.report!.submission_id, `Photo from ${sender}`)}>
              {/* eslint-disable-next-line @next/next/no-img-element -- streamed from the worker */}
              <img src={`/api/report-bot/image/${message.report.submission_id}`} alt={`Photo from ${sender}`} loading="lazy" />
            </button>
          ) : <div className={s.chatMedia}><Camera size={16} aria-hidden />Photo</div>
        ) : media.label ? <div className={s.chatMedia}>{media.icon}{media.label}</div> : null}
        {caption ? <p className={s.chatText}><RichText text={caption} names={names} /></p> : null}
        {verdict ? <span className={`${s.badge} ${verdict.tone} ${s.chatVerdict}`}>{verdict.label}</span> : null}
        <span className={s.chatTime}>{clock(message.ts)}</span>
      </div>
    </div>
  );
}

export function ReportBotChats({ groups, initialGroupId }: { groups: ChatGroup[]; initialGroupId: string | null }) {
  const [activeId, setActiveId] = useState<string | null>(initialGroupId);
  const [data, setData] = useState<ChatPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [image, setImage] = useState<{ src: string; title: string } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastCount = useRef(0);

  const load = useCallback(async (groupId: string, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`/api/report-bot/chats?group=${groupId}`, { cache: "no-store" });
      const payload = await response.json() as ChatPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not load this chat.");
      setData(payload);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load this chat.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!activeId) return;
    setData(null);
    stickToBottom.current = true;
    lastCount.current = 0;
    void load(activeId);
    const timer = setInterval(() => {
      if (!document.hidden) void load(activeId, true);
    }, POLL_MS);
    const url = new URL(window.location.href);
    url.searchParams.set("group", activeId);
    window.history.replaceState(null, "", url);
    return () => clearInterval(timer);
  }, [activeId, load]);

  // Follow new messages only when the reader is already at the bottom.
  useEffect(() => {
    const element = scroller.current;
    if (!element || !data) return;
    if (stickToBottom.current) element.scrollTop = element.scrollHeight;
    lastCount.current = data.messages.length;
  }, [data]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return groups.filter((group) => !needle || group.name.toLowerCase().includes(needle));
  }, [groups, query]);
  const byId = useMemo(() => new Map((data?.messages ?? []).map((message) => [message.id, message])), [data]);
  const active = groups.find((group) => group.id === activeId) ?? null;

  return (
    <div className={`${s.chatShell} ${activeId ? s.chatShellOpen : ""}`}>
      <aside className={s.chatList} aria-label="Groups">
        <div className={s.chatListHead}>
          <Search size={16} aria-hidden />
          <input className={s.input} type="search" placeholder="Search groups" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search groups" />
        </div>
        <ul>
          {filtered.map((group) => (
            <li key={group.id}>
              <button type="button" className={`${s.chatListItem} ${group.id === activeId ? s.chatListItemOn : ""}`} onClick={() => setActiveId(group.id)} aria-current={group.id === activeId ? "true" : undefined}>
                <span className={s.avatar} style={{ background: colourFor(group.id) }} aria-hidden>{group.name.slice(0, 1).toUpperCase()}</span>
                <span className={s.chatListText}>
                  <span className={s.chatListTop}><strong>{group.name}</strong>{group.lastAt ? <small>{new Date(group.lastAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</small> : null}</span>
                  <small>{group.preview ?? (group.size ? `${group.size} members` : "No activity yet")}</small>
                </span>
              </button>
            </li>
          ))}
          {!filtered.length ? <li className={s.modalStatus}>{groups.length ? "No group matches that search." : "No groups yet. Add them on the Groups tab."}</li> : null}
        </ul>
      </aside>

      <section className={s.chatPane} aria-label={active ? `Chat: ${active.name}` : "Chat"}>
        {active ? (
          <>
            <header className={s.chatHead}>
              <button type="button" className={`${s.button} ${s.small} ${s.ghost} ${s.chatBack}`} onClick={() => setActiveId(null)} aria-label="Back to groups"><ArrowLeft size={16} aria-hidden /></button>
              <span className={s.avatar} style={{ background: colourFor(active.id) }} aria-hidden>{active.name.slice(0, 1).toUpperCase()}</span>
              <div className={s.chatHeadText}>
                <strong>{data?.group.name ?? active.name}</strong>
                <small>
                  {data?.group.size ?? active.size ? `${data?.group.size ?? active.size} members · ` : ""}
                  {data ? (data.live ? (data.connected ? <span className={s.liveDot}>Live</span> : "Worker online, WhatsApp reconnecting") : "Stored history only") : "Loading…"}
                </small>
              </div>
              <button type="button" className={`${s.button} ${s.small} ${s.ghost}`} onClick={() => void load(active.id)} aria-label="Refresh"><RefreshCw size={15} className={loading ? "spin" : undefined} aria-hidden /></button>
            </header>
            <div
              className={s.chatScroll}
              ref={scroller}
              onScroll={(event) => {
                const element = event.currentTarget;
                stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
              }}
            >
              {data?.notice ? <div className={s.chatNotice}><WifiOff size={14} aria-hidden />{data.notice}</div> : null}
              {data?.live && data.since ? <div className={s.chatNotice}>Text messages are shown live while the worker runs (since {new Date(data.since * 1000).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}); they are not stored. Report photos and bot replies are kept for 3 days here.</div> : null}
              {error ? <div className={s.chatNotice} role="alert">{error}</div> : null}
              {!data && !error ? <div className={s.modalStatus}><Loader2 size={20} className="spin" aria-hidden />Loading messages…</div> : null}
              {data && !data.messages.length ? <div className={s.modalStatus}>No messages yet. New messages appear here as they arrive.</div> : null}
              {data?.messages.map((message, index) => {
                const previous = data.messages[index - 1];
                const newDay = !previous || dayLabel(previous.ts) !== dayLabel(message.ts);
                return (
                  <Fragment key={message.id}>
                    {newDay ? <div className={s.chatDay}><span>{dayLabel(message.ts)}</span></div> : null}
                    <Bubble message={message} names={data.names} byId={byId} onOpenImage={(id, title) => setImage({ src: `/api/report-bot/image/${id}`, title })} />
                  </Fragment>
                );
              })}
            </div>
            <footer className={s.chatFoot}>Read-only view of the group. Replies are approved on the Review tab.</footer>
          </>
        ) : (
          <div className={s.chatEmpty}>
            <Users size={36} aria-hidden />
            <strong>Pick a group</strong>
            <span>See the group as it looks in WhatsApp: report photos with their result and the bot&apos;s replies.</span>
          </div>
        )}
      </section>
      <ImageModal src={image?.src ?? ""} title={image?.title ?? "Photo"} open={Boolean(image)} onClose={() => setImage(null)} />
    </div>
  );
}
