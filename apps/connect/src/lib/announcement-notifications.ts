import type { SupabaseClient } from "@supabase/supabase-js";

type Notice = { event_code?: string; title: string; body: string; data?: Record<string, unknown> | null };
type Announcement = { id: string; title: string; body: string; status: string; expires_at: string | null };

export function announcementId(notice: Notice): string | null {
  if (!["communication_announcement", "communication_announcement_reminder"].includes(notice.event_code ?? "")) return null;
  const id = notice.data?.announcementId;
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

export function resolveAnnouncementNotices<T extends Notice>(notices: T[], announcements: Announcement[], now = Date.now()): T[] {
  const allowed = new Map(announcements.filter(a => a.status === "published" && (!a.expires_at || Date.parse(a.expires_at) > now)).map(a => [a.id, a]));
  return notices.flatMap(notice => {
    const id = announcementId(notice);
    if (!id) return [notice];
    const announcement = allowed.get(id);
    // Only a recipient's published update may open from their bell/banner.
    if (!announcement) return [];
    return [{ ...notice, title: announcement.title, body: announcement.body, data: { ...notice.data, openNotice: true } }];
  });
}

/** Full current copy comes from the announcement, never the truncated push preview. */
export async function hydrateAnnouncementNotices<T extends Notice>(db: SupabaseClient, account: { companyId: string; id: string; profileType: string }, notices: T[]): Promise<T[]> {
  const ids = [...new Set(notices.map(announcementId).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return notices;
  const result = await db.from("communication_announcement_recipients")
    .select("communication_announcements!inner(id,title,body,status,expires_at)")
    .eq("company_id", account.companyId).eq("recipient_account_id", account.id)
    .eq("recipient_profile_type", account.profileType).eq("communication_announcements.company_id", account.companyId)
    .in("announcement_id", ids);
  if (result.error) throw new Error("Unable to load update details. Please try again.");
  const announcements = (result.data ?? []).flatMap(row => row.communication_announcements) as unknown as Announcement[];
  return resolveAnnouncementNotices(notices, announcements);
}
