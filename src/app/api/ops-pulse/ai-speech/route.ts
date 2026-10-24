import { getAuthorization, hasPermission } from "@/lib/authorization";
import { assistantLanguage, ASSISTANT_LANGUAGES } from "@/lib/ops-pulse/assistant-language";
import { translateAssistantText, generateAssistantSpeech } from "@/lib/ops-pulse/assistant-speech";
export const dynamic = "force-dynamic";
export const maxDuration = 90;
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function POST(request: Request) {
  const auth = await getAuthorization();
  if (!auth) return Response.json({ error: "Please sign in again." }, { status: 401, headers });
  if (!hasPermission(auth, "ops_pulse", "access")) return Response.json({ error: "OpsPulse access is required." }, { status: 403, headers });
  const body = await request.json().catch(() => null);
  if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > 6000 || !Object.hasOwn(ASSISTANT_LANGUAGES, body?.language || "")) return Response.json({ error: "Choose a supported language and an answer of up to 6,000 characters." }, { status: 400, headers });
  const language = assistantLanguage(body.language);
  try {
    const text = await translateAssistantText(body.text.trim(), language);
    const speech = await generateAssistantSpeech(text, language);
    return Response.json({ text, language, ...speech }, { headers });
  } catch (error) {
    console.warn("[ops-assistant-speech]", error instanceof Error ? error.message : "unavailable");
    return Response.json({ error: `${ASSISTANT_LANGUAGES[language]} audio is unavailable right now. Please retry. An English voice has not been substituted.` }, { status: 503, headers });
  }
}
