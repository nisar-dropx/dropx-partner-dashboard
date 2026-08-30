import { getAuthorization, hasPermission } from "@/lib/authorization";
import { parseAiMailDraft } from "@/lib/ai-mail-draft";
import { requireCompanyId } from "@/lib/company-scope";
import { googleCloudAccessToken } from "@/lib/google-workspace-client";
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

function vertexResponseText(payload: any) {
  return (payload?.candidates?.[0]?.content?.parts ?? [])
    .map((part: any) => part?.text ?? "").filter(Boolean).join("\n");
}

export async function POST(request: Request) {
  const authorization = await getAuthorization();
  if (!authorization || !hasPermission(authorization, "ops_location_mail", "edit")) {
    return Response.json({ error: "Mail edit access is required." }, { status: 403 });
  }
  if (!supabaseAdmin) return Response.json({ error: "Database unavailable." }, { status: 500 });
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
  const instructions = [
    "You are DropX Mail AI, an internal business-email drafting assistant for logistics operations.",
    "Return only valid JSON with exactly two string fields: subject and body.",
    "Never invent names, dates, shipment volumes, commitments, causes, approvals or client positions.",
    "Use only details supplied by the user. If an essential fact is missing, use a neutral sentence or an explicit [confirm detail] placeholder.",
    "Do not add a signature because OpsPulse appends the configured station signature automatically.",
    "Do not include markdown, commentary or legal claims. Keep the requested tone and length."
  ].join(" ");
  const draftContext = JSON.stringify({
    station: { code: station?.station_code ?? null, name: station?.station_name ?? null, sender: addressResult.data.email_address },
    action, tone, length, purpose, recipients,
    currentDraft: { subject: currentSubject, body: currentBody }
  });
  let generated: unknown = "";
  let provider = "";
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (apiKey) {
    const ai = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_OPS_MODEL || "gpt-5.6-sol",
        instructions,
        input: draftContext,
        max_output_tokens: 1600,
        text: { verbosity: "low" }
      })
    });
    const payload = await ai.json().catch(() => ({}));
    if (!ai.ok) return Response.json({ error: payload?.error?.message ?? "AI compose request failed." }, { status: 502 });
    generated = responseText(payload);
    provider = "OpenAI";
  } else if (process.env.CLOUDFLARE_AI_API_TOKEN?.trim() && process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID.trim();
    const cloudflareToken = process.env.CLOUDFLARE_AI_API_TOKEN.trim();
    const model = process.env.CLOUDFLARE_AI_MODEL?.trim() || "@cf/meta/llama-3.1-8b-instruct";
    const ai = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${cloudflareToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: draftContext }
        ],
        max_tokens: 1600,
        temperature: 0.2,
        response_format: {
          type: "json_schema",
          json_schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              subject: { type: "string" },
              body: { type: "string" }
            },
            required: ["subject", "body"]
          }
        }
      })
    });
    const payload = await ai.json().catch(() => ({}));
    if (!ai.ok || payload?.success === false) {
      const message = payload?.errors?.[0]?.message || payload?.error?.message || "Cloudflare Workers AI compose request failed.";
      return Response.json({ error: message }, { status: 502 });
    }
    generated = payload?.result?.response ?? payload?.result;
    provider = "Cloudflare Workers AI";
  } else {
    try {
      const cloud = await googleCloudAccessToken();
      const model = process.env.GOOGLE_VERTEX_MAIL_MODEL?.trim() || "gemini-2.5-flash";
      const url = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(cloud.projectId)}/locations/global/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
      const ai = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${cloud.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [{ role: "user", parts: [{ text: draftContext }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1600,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              required: ["subject", "body"],
              properties: { subject: { type: "STRING" }, body: { type: "STRING" } }
            }
          }
        })
      });
      const payload = await ai.json().catch(() => ({}));
      if (!ai.ok) return Response.json({ error: payload?.error?.message ?? "Google Vertex AI compose request failed." }, { status: 502 });
      generated = vertexResponseText(payload);
      provider = "Google Vertex AI";
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "AI compose is not configured." }, { status: 503 });
    }
  }
  try {
    return Response.json({ ...parseAiMailDraft(generated), provider });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "AI returned an invalid draft." }, { status: 502 });
  }
}
