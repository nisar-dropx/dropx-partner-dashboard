import { getAuthorization, hasPermission } from "@/lib/authorization";
import { currentAdminAccessSurface } from "@/lib/access-surface";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { scopedWorkforceCases, workforceConnectOpenStatuses, workforceConnectStatuses } from "@/lib/workforce-connect";
import { deliverNotificationPush } from "@/lib/firebase-push";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const uuid = /^[a-f0-9-]{36}$/i;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });

async function authorize(write = false) {
  if (currentAdminAccessSurface() !== "dashboard") return null;
  const auth = await getAuthorization();
  if (!auth?.companyId || !hasPermission(auth, "workforce_connect", write ? "edit" : "view")
    || (write && (auth.readOnly || auth.isPreview))) return null;
  return auth;
}

export async function GET(request: Request) {
  const auth = await authorize();
  if (!auth) return json({ error: "Workforce Connect access required." }, 403);
  try {
    if (!supabaseAdmin) throw new Error("Database unavailable");
    const params = new URL(request.url).searchParams;
    const caseId = params.get("case");
    if (caseId) {
      if (!uuid.test(caseId)) return json({ error: "Conversation unavailable." }, 404);
      const result = await scopedWorkforceCases(auth).eq("id", caseId).maybeSingle();
      if (result.error) throw result.error;
      if (!result.data) return json({ error: "Conversation unavailable in this inbox." }, 404);
      // Do not load messages or mint file links until the case passes both scopes.
      const [messages, files, events, owner, station] = await Promise.all([
        supabaseAdmin.from("communication_case_messages").select("id,author_kind,visibility,body,created_at").eq("company_id", auth.companyId).eq("case_id", caseId).order("created_at"),
        supabaseAdmin.from("communication_case_attachments").select("id,original_name,storage_path").eq("company_id", auth.companyId).eq("case_id", caseId).order("created_at"),
        supabaseAdmin.from("communication_case_events").select("id,event_type,to_status,created_at").eq("company_id", auth.companyId).eq("case_id", caseId).order("created_at", { ascending: false }).limit(50),
        result.data.assigned_profile_id ? supabaseAdmin.from("profiles").select("full_name").eq("company_id", auth.companyId).eq("id", result.data.assigned_profile_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
        result.data.location_id ? supabaseAdmin.from("stations").select("station_code,station_name").eq("company_id", auth.companyId).eq("id", result.data.location_id).maybeSingle() : Promise.resolve({ data: null, error: null })
      ]);
      for (const value of [messages, files, events, owner, station]) if (value.error) throw value.error;
      const attachments = await Promise.all((files.data ?? []).map(async (file) => {
        const signed = await supabaseAdmin!.storage.from("communication-evidence").createSignedUrl(file.storage_path, 120);
        return { id: file.id, name: file.original_name, url: signed.error ? null : signed.data.signedUrl };
      }));
      return json({ conversation: result.data, messages: messages.data, attachments, events: events.data,
        owner: owner.data?.full_name ?? "Unassigned", station: station.data ? `${station.data.station_code} · ${station.data.station_name}` : "—" });
    }
    const channel = params.get("channel") === "integrity" ? "integrity" : "connect";
    const status = params.get("status");
    const q = (params.get("q") ?? "").trim().slice(0, 100).replace(/[^\p{L}\p{N}\s@_-]/gu, "");
    const page = Math.max(0, Math.min(10000, Number(params.get("page")) || 0));
    let query = scopedWorkforceCases(auth).eq("channel", channel);
    if (workforceConnectStatuses.includes(status ?? "")) query = query.eq("status", status!);
    if (status === "open") query = query.in("status", workforceConnectOpenStatuses);
    if (params.get("owner") === "me") query = query.eq("assigned_profile_id", auth.userId);
    if (params.get("owner") === "unassigned") query = query.is("assigned_profile_id", null);
    if (q) query = query.or(`case_number.ilike.%${q}%,subject.ilike.%${q}%,reporter_name.ilike.%${q}%,reporter_code.ilike.%${q}%`);
    const [list, open, overdue] = await Promise.all([
      query.order("last_activity_at", { ascending: false }).range(page * 50, page * 50 + 49),
      scopedWorkforceCases(auth, true).in("status", workforceConnectOpenStatuses),
      scopedWorkforceCases(auth, true).in("status", workforceConnectOpenStatuses).lt("due_at", new Date().toISOString())
    ]);
    for (const value of [list, open, overdue]) if (value.error) throw value.error;
    return json({ cases: list.data, total: list.count, open: open.count, overdue: overdue.count });
  } catch { return json({ error: "Unable to load Workforce Connect. Please retry." }, 503); }
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) return json({ error: "Invalid request origin." }, 403);
  const auth = await authorize(true);
  if (!auth) return json({ error: "Reply permission is required. Previews are read-only." }, 403);
  try {
    if (!supabaseAdmin) throw new Error("Database unavailable");
    const body = await request.json();
    const caseId = String(body.caseId ?? "");
    if (!uuid.test(caseId)) return json({ error: "Select a conversation." }, 400);
    const current = await scopedWorkforceCases(auth).eq("id", caseId).maybeSingle();
    if (current.error) throw current.error;
    if (!current.data) return json({ error: "Conversation unavailable in this inbox." }, 404);
    const intent = String(body.intent ?? "");
    const value = String(body.value ?? "").trim();
    if (!["reply", "note", "assign", "status"].includes(intent) || value.length > 3000) return json({ error: "Invalid action." }, 400);
    if ((intent === "reply" || intent === "note") && value.length < 2) return json({ error: "Enter a message." }, 400);
    if (intent === "reply" && ["closed", "dismissed"].includes(current.data.status)) return json({ error: "Reopen the conversation before replying." }, 409);
    if (intent === "status" && !workforceConnectStatuses.includes(value)) return json({ error: "Select a valid status." }, 400);
    const saved = intent === "reply"
      ? await supabaseAdmin.rpc("send_workforce_communication_reply", { p_company_id: auth.companyId, p_case_id: caseId, p_actor_id: auth.userId, p_message: value })
      : await supabaseAdmin.rpc("manage_workforce_communication_case", { p_company_id: auth.companyId, p_case_id: caseId, p_actor_id: auth.userId, p_intent: intent, p_value: value });
    if (saved.error) throw saved.error;
    if (saved.data) {
      // Claim before sending; the existing scheduled push retry handles failures.
      try {
        const claim = await supabaseAdmin.rpc("claim_connect_push", { p_notification_id: saved.data });
        const n = claim.data?.[0];
        if (n) await deliverNotificationPush({ id: n.id, companyId: n.company_id, profileType: n.recipient_profile_type,
          accountId: n.recipient_account_id, title: n.title, body: n.body, route: n.route, data: n.data });
      } catch { /* Persisted notification remains eligible for retry. */ }
    }
    return json({ ok: true, notice: saved.data ? "Saved. An in-app notification was created; phone push depends on the associate’s device permissions." : "Saved." });
  } catch { return json({ error: "Could not save this action. Refresh the conversation before retrying." }, 503); }
}
