import { getAuthorization, hasPermission } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nlStationScope } from "@/lib/ops-pulse/nl-loss";
import { isRecoverable } from "@/lib/ops-pulse/nl-loss-policy";
import { readAllRows } from "@/lib/supabase-pagination";
export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
async function context(month: string, key: string, edit: boolean) {
  const auth = await getAuthorization();
  if (
    !auth ||
    !hasPermission(auth, "ops_losses", edit ? "edit" : "access") ||
    (edit && auth.readOnly)
  )
    throw Error("Access denied.");
  if (
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
    !key ||
    key.length > 300 ||
    !supabaseAdmin
  )
    throw Error("Invalid recovery case.");
  const scope = await nlStationScope(auth);
  const settings = await supabaseAdmin
    .from("nl_loss_sources")
    .select("recoverable_statuses,include_inactive_people")
    .eq("company_id", scope.company)
    .maybeSingle();
  const row = await supabaseAdmin
    .from("nl_loss_month_cases")
    .select("station_code,source_status,source_present")
    .eq("company_id", scope.company)
    .eq("month", month)
    .eq("case_key", key)
    .maybeSingle();
  const station = scope.stations.find(
    (s) => s.source_code === row.data?.station_code,
  );
  if (
    row.error ||
    !station ||
    !row.data?.source_present ||
    !isRecoverable(
      row.data.source_status,
      settings.data?.recoverable_statuses ?? [],
    )
  )
    throw Error("Case is unavailable or outside your station access.");
  return { auth, scope, station, settings: settings.data };
}
export async function GET(request: Request) {
  try {
    const url = new URL(request.url),
      month = url.searchParams.get("month") || "",
      key = url.searchParams.get("case") || "";
    const { scope, station, settings } = await context(month, key, false);
    const [people, history] = await Promise.all([
      supabaseAdmin!.rpc("station_audit_employee_directory", {
        p_company: scope.company,
        p_station: station.id,
      }),
      readAllRows(
        supabaseAdmin!
          .from("nl_loss_recovery_events")
          .select("id,after_value,actor_name,created_at")
          .eq("company_id", scope.company)
          .eq("month", month)
          .eq("case_key", key)
          .order("created_at", { ascending: false }),
      ),
    ]);
    if (people.error || history.error)
      throw Error("Recovery people and history could not be loaded.");
    return reply({
      people: (people.data ?? []).filter(
        (p: { is_active: boolean }) =>
          settings?.include_inactive_people || p.is_active,
      ),
      history: history.data ?? [],
    });
  } catch (e) {
    return reply(
      { error: e instanceof Error ? e.message : "Unable to load recovery." },
      403,
    );
  }
}
export async function POST(request: Request) {
  try {
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== new URL(request.url).origin
    )
      return reply({ error: "Invalid request origin." }, 403);
    const body = await request.json();
    const { auth, scope } = await context(
      String(body.month || ""),
      String(body.case_key || ""),
      true,
    );
    if (
      !Number.isInteger(body.version) ||
      body.version < 0 ||
      !Array.isArray(body.allocations) ||
      body.allocations.length > 50 ||
      typeof body.outcome !== "string" ||
      typeof body.remarks !== "string" ||
      body.remarks.length > 2000
    )
      return reply({ error: "Invalid recovery values." }, 400);
    const result = await supabaseAdmin!.rpc("save_nl_recovery", {
      p_company: scope.company,
      p_month: body.month,
      p_case: body.case_key,
      p_version: body.version,
      p_outcome: body.outcome,
      p_mode: body.split_mode,
      p_allocations: body.allocations,
      p_remarks: body.remarks,
      p_actor: auth.userId,
      p_name: auth.fullName || auth.email || "OpsPulse user",
    });
    if (result.error)
      return reply(
        {
          error:
            result.error.code === "P0001"
              ? result.error.message
              : "Recovery could not be saved. Refresh and try again.",
        },
        409,
      );
    return reply({ recovery: result.data });
  } catch (e) {
    return reply(
      {
        error: e instanceof Error ? e.message : "Recovery could not be saved.",
      },
      403,
    );
  }
}

export async function DELETE(request: Request) {
  try {
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== new URL(request.url).origin
    )
      return reply({ error: "Invalid request origin." }, 403);
    const b = await request.json();
    const { auth, scope } = await context(
      String(b.month || ""),
      String(b.case_key || ""),
      true,
    );
    if (!Number.isInteger(b.version) || b.version < 1)
      return reply({ error: "Invalid recovery version." }, 400);
    const r = await supabaseAdmin!.rpc("clear_nl_recovery", {
      p_company: scope.company,
      p_month: b.month,
      p_case: b.case_key,
      p_version: b.version,
      p_actor: auth.userId,
      p_name: auth.fullName || auth.email || "OpsPulse user",
    });
    if (r.error)
      return reply(
        {
          error:
            r.error.code === "P0001"
              ? r.error.message
              : "Recovery could not be removed.",
        },
        409,
      );
    return reply({ recovery: r.data });
  } catch (e) {
    return reply(
      {
        error:
          e instanceof Error ? e.message : "Recovery could not be removed.",
      },
      403,
    );
  }
}
