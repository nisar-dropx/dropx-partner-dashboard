import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function clean(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function responseText(payload: any) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (payload?.output ?? []).flatMap((item: any) => item?.content ?? [])
    .map((item: any) => item?.text ?? "").filter(Boolean).join("\n");
}

function parseDraft(value: string) {
  const normalized = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(normalized) as { subject?: unknown; body?: unknown };
  const subject = clean(parsed.subject, 180);
  const body = clean(parsed.body, 12000);
  if (!subject || !body) throw new Error("AI returned an incomplete draft.");
  return { subject, body };
}

export async function POST(request: Request) {
  const authorization = await getAuthorization();
  if (!authorization || !hasPermission(authorization, "ops_location_mail", "edit")) {
    return Response.json({ error: "Mail edit access is required." }, { status: 403 });
  }
  if (!supabaseAdmin) return Response.json({ error: "Database unavailable." }, { status: 500 });
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return Response.json({ error: "AI compose is not configured." }, { status: 503 });
  const input = await request.json().catch(() => ({}));
  const stationAddressId = clean(input.stationAddressId, 80);
  const purpose = clean(input.purpose, 2000);
  if (!stationAddressId || !purpose) return Response.json({ error: "Station and email purpose are required." }, { status: 400 });
  const companyId = requireCompanyId(authorization);
  const addressResult = await supabaseAdmin.from("ops_location_mailbox_addresses")
    .select("station_id,email_address,stations(station_code,station_name)")
    .eq("company_id", companyId).eq("id", stationAddressId).eq("is_active", true).maybeSingle();
  if (addressResult.error || !addressResult.data) return Response.json({ error: "Station sender was not found." }, { status: 404 });
  if (!authorization.hasAllLocationAccess && !authorization.isMasterOwner && !authorization.locationScopeIds.includes(addressResult.data.station_id)) {
    return Response.json({ error: "You do not have access to this station sender." }, { status: 403 });
  }
  const station = Array.isArray(addressResult.data.stations) ? addressResult.data.stations[0] : addressResult.data.stations;
  const action = clean(input.action, 30) || "write";
  const tone = clean(input.tone, 30) || "formal";
  const length = clean(input.length, 30) || "concise";
  const currentSubject = clean(input.currentSubject, 180);
  const currentBody = clean(input.currentBody, 6000);
  const recipients = clean(input.recipients, 1200);
  const ai = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_OPS_MODEL || "gpt-5.6-sol",
      instructions: [
        "You are DropX Mail AI, an internal business-email drafting assistant for logistics operations.",
        "Return only valid JSON with exactly two string fields: subject and body.",
        "Never invent names, dates, shipment volumes, commitments, causes, approvals or client positions.",
        "Use only details supplied by the user. If an essential fact is missing, use a neutral sentence or an explicit [confirm detail] placeholder.",
        "Do not add a signature because OpsPulse appends the configured station signature automatically.",
        "Do not include markdown, commentary or legal claims. Keep the requested tone and length."
      ].join(" "),
      input: JSON.stringify({
        station: { code: station?.station_code ?? null, name: station?.station_name ?? null, sender: addressResult.data.email_address },
        action, tone, length, purpose, recipients,
        currentDraft: { subject: currentSubject, body: currentBody }
      }),
      max_output_tokens: 1600,
      text: { verbosity: "low" }
    })
  });
  const payload = await ai.json().catch(() => ({}));
  if (!ai.ok) return Response.json({ error: payload?.error?.message ?? "AI compose request failed." }, { status: 502 });
  try {
    return Response.json(parseDraft(responseText(payload)));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "AI returned an invalid draft." }, { status: 502 });
  }
}
