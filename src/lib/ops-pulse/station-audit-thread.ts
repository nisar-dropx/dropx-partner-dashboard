import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";

/** One durable station conversation, including legacy threads across types/months. */
export async function acquireStationAuditThread(
  companyId: string,
  locationId: string,
  stationCode: string,
) {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  const db = supabaseAdmin;
  const read = () =>
    db
      .from("ops_station_audit_email_threads")
      .select("*")
      .eq("company_id", companyId)
      .eq("location_id", locationId)
      .order("created_at")
      .order("id")
      .limit(1)
      .maybeSingle();
  let found = await read();
  if (found.error) throw new Error(found.error.message);
  if (!found.data) {
    // The existing schema requires a type. Choose one stable company type for
    // the initial insert so simultaneous COD/physical sends hit the same unique key.
    const type = await db
      .from("ops_audit_types")
      .select("id")
      .eq("company_id", companyId)
      .order("id")
      .limit(1)
      .maybeSingle();
    if (type.error || !type.data)
      throw new Error(type.error?.message || "Audit type is unavailable.");
    const created = await db.from("ops_station_audit_email_threads").insert({
      company_id: companyId,
      location_id: locationId,
      audit_type_id: type.data.id,
      thread_month: "station",
      subject: `${stationCode} · Station audit updates`,
      root_message_id: `<dropx.audit.${randomUUID()}@partner.dropxlogistics.com>`,
    });
    if (created.error && created.error.code !== "23505")
      throw new Error(created.error.message);
    found = await read();
    if (found.error || !found.data)
      throw new Error(
        found.error?.message || "Station email thread could not be created.",
      );
  }
  const token = randomUUID();
  const now = Date.now();
  const locked = await db
    .from("ops_station_audit_email_threads")
    .update({
      lock_token: token,
      locked_until: new Date(now + 180_000).toISOString(),
    })
    .eq("company_id", companyId)
    .eq("id", found.data.id)
    .or(`locked_until.is.null,locked_until.lt.${new Date(now).toISOString()}`)
    .select("*")
    .maybeSingle();
  if (locked.error) throw new Error(locked.error.message);
  if (!locked.data)
    throw new Error(
      "Another audit email is being sent for this station. Please retry shortly.",
    );
  const thread = locked.data;
  return {
    subject: thread.subject,
    messageId: thread.last_message_id
      ? `<dropx.audit.${randomUUID()}@partner.dropxlogistics.com>`
      : thread.root_message_id,
    inReplyTo: thread.last_message_id || undefined,
    references: thread.last_message_id
      ? [...new Set<string>([thread.root_message_id, thread.last_message_id])]
      : undefined,
    async finish(messageId: string) {
      const saved = await db
        .from("ops_station_audit_email_threads")
        .update({
          last_message_id: messageId,
          lock_token: null,
          locked_until: null,
          updated_at: new Date().toISOString(),
        })
        .eq("company_id", companyId)
        .eq("id", thread.id)
        .eq("lock_token", token)
        .select("id")
        .maybeSingle();
      if (saved.error || !saved.data)
        throw new Error(
          saved.error?.message ||
            "Email sent, but its thread could not be updated. Check delivery before resending.",
        );
    },
    async release() {
      await db
        .from("ops_station_audit_email_threads")
        .update({ lock_token: null, locked_until: null })
        .eq("company_id", companyId)
        .eq("id", thread.id)
        .eq("lock_token", token);
    },
  };
}
