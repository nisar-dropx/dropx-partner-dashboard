import type { SupabaseClient } from "@supabase/supabase-js";

/** user_id references auth.users, not public.profiles: resolve the two tables explicitly. */
export async function loadReviewUserLinks(db: SupabaseClient, companyId: string, personIds: string[]) {
  if (!personIds.length) return new Map<string,string>();
  const links = await db.from("hr_user_person_links").select("person_id,user_id")
    .eq("company_id",companyId).eq("status","active").in("person_id",personIds);
  if (links.error) throw new Error("Unable to load People account links.");
  const userIds = [...new Set((links.data ?? []).map(link => link.user_id))];
  if (!userIds.length) return new Map<string,string>();
  const profiles = await db.from("profiles").select("id").eq("company_id",companyId).eq("is_active",true).in("id",userIds);
  if (profiles.error) throw new Error("Unable to check reviewer accounts.");
  const active = new Set((profiles.data ?? []).map(profile => profile.id));
  return new Map<string,string>((links.data ?? []).filter(link => active.has(link.user_id)).map(link => [link.person_id,link.user_id]));
}
