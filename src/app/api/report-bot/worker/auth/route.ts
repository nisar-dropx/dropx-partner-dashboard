import { NextResponse } from "next/server";
import { reportBotDb, settingsForWorkerRequest } from "@/lib/report-bot/settings";

export const dynamic = "force-dynamic";

// Baileys keys look like "session-91987…:12@s.whatsapp.net" or "sender-key-1203…@g.us::91987…::0".
// Any printable ASCII is accepted: rejecting an unexpected key would silently break decryption.
const KEY = /^[\x21-\x7e]{1,300}$/;
const MAX_KEYS = 500;
const MAX_VALUE = 200_000;
// `.in()` filters travel in the request URL; long Signal key names would overflow it.
const QUERY_CHUNK = 80;

function chunks<T>(list: T[], size: number) {
  const out: T[][] = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
}

/**
 * The worker's WhatsApp login lives here instead of on its disk.
 * Body: { action: "get", keys } | { action: "set", entries: { key: value|null } } | { action: "clear" }.
 */
export async function POST(request: Request) {
  let settings;
  try {
    settings = await settingsForWorkerRequest(request);
  } catch {
    return NextResponse.json({ error: "Temporarily unavailable" }, { status: 503 });
  }
  if (!settings) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as { action?: string; keys?: unknown; entries?: unknown } | null;
  const db = reportBotDb();
  const companyId = settings.company_id;

  if (body?.action === "get") {
    const keys = Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === "string" && KEY.test(key)) : [];
    if (!keys.length || keys.length > MAX_KEYS) return NextResponse.json({ error: `Ask for 1 to ${MAX_KEYS} valid keys.` }, { status: 400 });
    const values: Record<string, string> = {};
    for (const part of chunks(keys, QUERY_CHUNK)) {
      const result = await db.from("report_bot_wa_auth").select("key,value").eq("company_id", companyId).in("key", part);
      if (result.error) return NextResponse.json({ error: "Could not read the session" }, { status: 500 });
      for (const row of result.data ?? []) values[row.key] = row.value;
    }
    return NextResponse.json({ values });
  }

  if (body?.action === "set") {
    const entries = body.entries && typeof body.entries === "object" && !Array.isArray(body.entries) ? Object.entries(body.entries as Record<string, unknown>) : [];
    if (!entries.length || entries.length > MAX_KEYS) return NextResponse.json({ error: `Send 1 to ${MAX_KEYS} entries.` }, { status: 400 });
    if (entries.some(([key, value]) => !KEY.test(key) || (value !== null && (typeof value !== "string" || value.length > MAX_VALUE)))) {
      return NextResponse.json({ error: "Invalid key or value." }, { status: 400 });
    }
    const now = new Date().toISOString();
    const upserts = entries.filter(([, value]) => value !== null).map(([key, value]) => ({ company_id: companyId, key, value: value as string, updated_at: now }));
    const deletes = entries.filter(([, value]) => value === null).map(([key]) => key);
    if (upserts.length) {
      const result = await db.from("report_bot_wa_auth").upsert(upserts, { onConflict: "company_id,key" });
      if (result.error) return NextResponse.json({ error: "Could not save the session" }, { status: 500 });
    }
    for (const part of chunks(deletes, QUERY_CHUNK)) {
      const result = await db.from("report_bot_wa_auth").delete().eq("company_id", companyId).in("key", part);
      if (result.error) return NextResponse.json({ error: "Could not save the session" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  if (body?.action === "clear") {
    const result = await db.from("report_bot_wa_auth").delete().eq("company_id", companyId);
    if (result.error) return NextResponse.json({ error: "Could not clear the session" }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
