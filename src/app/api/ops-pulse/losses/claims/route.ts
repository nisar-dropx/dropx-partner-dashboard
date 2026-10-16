import { getAuthorization } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nlStationScope } from "@/lib/ops-pulse/nl-loss";
import { canRaiseClaims, loadStationClaims } from "@/lib/ops-pulse/station-claims";
import { claimNoteError, validateClaim, type ClaimAction } from "@/lib/ops-pulse/station-claims-policy";

export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const dbError = (e: { code?: string; message: string }, fallback: string) => (e.code === "P0001" ? e.message : fallback);

/** Raise a claim, or move one (approve / return / reject by the station's cluster manager; resubmit / withdraw by the raiser). */
export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin) return reply({ error: "Invalid request origin." }, 403);
    const auth = await getAuthorization();
    if (!auth || !supabaseAdmin) return reply({ error: "Sign in again." }, 401);
    if (auth.readOnly) return reply({ error: "Read-only access cannot change claims." }, 403);
    const body = await request.json().catch(() => ({}));
    const name = auth.fullName || auth.email || "Ops user";
    if (body.kind === "raise") {
      if (!canRaiseClaims(auth)) return reply({ error: "You do not have access to raise station loss claims." }, 403);
      const input = {
        stationId: String(body.stationId ?? ""), reference: String(body.reference ?? ""), incidentDate: String(body.incidentDate ?? ""),
        category: String(body.category ?? ""), amount: String(body.amount ?? ""), description: String(body.description ?? ""),
        evidenceUrl: String(body.evidenceUrl ?? ""), people: String(body.people ?? ""),
      };
      const invalid = validateClaim(input);
      if (invalid) return reply({ error: invalid }, 400);
      const { company, stations } = await nlStationScope(auth);
      const station = stations.find((s) => s.id === input.stationId);
      if (!station) return reply({ error: "That station is outside your access." }, 403);
      const r = await supabaseAdmin.rpc("station_claim_submit", {
        p_company: company, p_station: station.id, p_station_code: station.source_code, p_reference: input.reference.trim(),
        p_incident_date: input.incidentDate, p_category: input.category, p_amount: Number(input.amount), p_description: input.description.trim(),
        p_evidence_url: input.evidenceUrl.trim() || null, p_people: input.people.trim() || null, p_actor: auth.userId, p_name: name,
      });
      if (r.error) return reply({ error: dbError(r.error, "The claim could not be raised.") }, 409);
      return reply({ ok: true, message: `Claim ${r.data.reference} sent to the cluster manager.` });
    }
    const id = String(body.claimId ?? ""), action = String(body.action ?? "") as ClaimAction, note = String(body.note ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id) || !["approve", "reject", "return", "resubmit", "withdraw"].includes(action) || !Number.isInteger(body.version))
      return reply({ error: "This request is invalid. Refresh and try again." }, 400);
    const noteErr = claimNoteError(action, note);
    if (noteErr) return reply({ error: noteErr }, 400);
    // Allowed actions are recomputed on the server: station scope, cluster manager, never one's own claim.
    const view = await loadStationClaims(auth);
    const claim = view.claims.find((c) => c.id === id);
    if (!claim) return reply({ error: "This claim is not in your stations." }, 403);
    if (!claim.actions.includes(action))
      return reply({ error: ["approve", "reject", "return"].includes(action) ? "Only the station's cluster manager can decide this claim, and never their own." : "Only the person who raised this claim can do that, at this stage." }, 403);
    let patch = {};
    if (action === "resubmit") {
      const invalid = validateClaim({ stationId: claim.stationId, reference: claim.reference, incidentDate: claim.incidentDate, category: claim.category, amount: String(body.amount ?? ""), description: String(body.description ?? ""), evidenceUrl: String(body.evidenceUrl ?? ""), people: "" });
      if (invalid) return reply({ error: invalid }, 400);
      patch = { amount: String(body.amount).trim(), description: String(body.description).trim(), evidence_url: String(body.evidenceUrl ?? "").trim() };
    }
    const r = await supabaseAdmin.rpc("station_claim_transition", { p_company: view.company, p_claim: id, p_action: action, p_version: body.version, p_actor: auth.userId, p_name: name, p_note: note.trim() || null, p_patch: patch });
    if (r.error) return reply({ error: dbError(r.error, "The claim could not be updated.") }, 409);
    const done: Record<ClaimAction, string> = {
      approve: "Approved. Assign the people responsible below; the recovery then follows payroll.",
      reject: "Claim rejected.", return: "Returned to the station for more information.",
      resubmit: "Resubmitted to the cluster manager.", withdraw: "Claim withdrawn.",
    };
    return reply({ ok: true, message: done[action] });
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : "The claim could not be saved." }, 500);
  }
}
