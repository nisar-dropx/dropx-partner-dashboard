import Link from "next/link";
import { ArrowLeft, MessageCircle, Settings2 } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { ReportBotChats } from "@/components/report-bot-chats";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { canSeeGroup, REPORT_BOT_PAGE } from "@/lib/report-bot/access";
import { reportBotDb } from "@/lib/report-bot/settings";
import s from "../report-bot.module.css";
import { ReportBotNav, SETUP_HREF } from "../ui";

export const dynamic = "force-dynamic";

/** WhatsApp Web style view of the report groups the bot is on. */
export default async function ReportBotChatsPage({ searchParams }: { searchParams?: { group?: string } }) {
  const authorization = await requirePagePermission(REPORT_BOT_PAGE, "access");
  const companyId = requireCompanyId(authorization);
  const db = reportBotDb();
  const groupsResult = await db.from("report_bot_groups").select("id,group_name,participant_count,location_id,is_enabled")
    .eq("company_id", companyId).eq("is_enabled", true).order("group_name");
  const groups = (groupsResult.data ?? []).filter((group) => canSeeGroup(authorization, group));
  const ids = groups.map((group) => group.id);

  // Latest stored activity per group for the list preview (photos and bot posts).
  const [photos, posts] = ids.length ? await Promise.all([
    db.from("report_bot_submissions").select("group_id,message_at,sender_name").in("group_id", ids).order("message_at", { ascending: false }).limit(300),
    db.from("report_bot_outbox").select("group_id,sent_at,kind").in("group_id", ids).eq("status", "sent").order("sent_at", { ascending: false }).limit(300)
  ]) : [{ data: [] }, { data: [] }];
  const latest = new Map<string, { at: string; preview: string }>();
  for (const row of photos.data ?? []) {
    const current = latest.get(row.group_id);
    if (!current || row.message_at > current.at) latest.set(row.group_id, { at: row.message_at, preview: `📷 ${row.sender_name ?? "Member"} sent a photo` });
  }
  for (const row of posts.data ?? []) {
    const current = latest.get(row.group_id);
    if (row.sent_at && (!current || row.sent_at > current.at)) latest.set(row.group_id, { at: row.sent_at, preview: row.kind === "feedback" ? "🤖 Bot replied to a report" : "🤖 Bot sent a reminder" });
  }
  const chatGroups = groups
    .map((group) => ({
      id: group.id,
      name: group.group_name ?? "Unnamed group",
      size: group.participant_count,
      preview: latest.get(group.id)?.preview ?? null,
      lastAt: latest.get(group.id)?.at ?? null
    }))
    .sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || a.name.localeCompare(b.name));
  const initial = chatGroups.find((group) => group.id === searchParams?.group)?.id ?? null;

  return (
    <AppShell active="Report Bot" pageCode={REPORT_BOT_PAGE}>
      <div className={s.page}>
        <header className={s.hero}>
          <div>
            <span className={s.eyebrow}><MessageCircle size={13} aria-hidden /> Report Bot · Chats</span>
            <h1>Group chats</h1>
            <p>Each report group as it looks in WhatsApp, with every report photo&apos;s result and the bot&apos;s replies. Updates live.</p>
          </div>
          <div className={s.formActions}>
            <Link className={s.button} href="/report-bot"><ArrowLeft size={15} aria-hidden />Report Bot</Link>
            <Link className={s.button} href={SETUP_HREF}><Settings2 size={15} aria-hidden />Setup</Link>
          </div>
        </header>
        <ReportBotNav active="chats" />
        <ReportBotChats groups={chatGroups} initialGroupId={initial} />
      </div>
    </AppShell>
  );
}
