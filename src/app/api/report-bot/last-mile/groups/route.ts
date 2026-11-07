import { pushWorkerConfig } from "@/lib/report-bot/push-config";
import { NextResponse } from "next/server";
import { reportBotApiAuthorization } from "@/lib/report-bot/access";
import { loadReportBotSettings, reportBotDb } from "@/lib/report-bot/settings";
import {
  workerRequest,
  WorkerError,
  type WorkerGroup,
} from "@/lib/report-bot/worker-client";
import { loadCodLocations, locationModelName } from "@/lib/ops-pulse/cod";
import { discoveryLocations } from "@/lib/report-bot/lm-group-scope";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function directory(request?: Request) {
  const auth = await reportBotApiAuthorization("edit", "last_mile");
  if (!auth)
    return NextResponse.json({ error: "Access denied." }, { status: 403 });
  const company = auth.companyId!;
  const db = reportBotDb();
  try {
    let selection: { group: string; station: string } | null = null;
    if (request) {
      if (request.headers.get("origin") !== new URL(request.url).origin)
        return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
      selection = await request.json().catch(() => null);
      if (
        !selection ||
        typeof selection.group !== "string" ||
        typeof selection.station !== "string"
      )
        return NextResponse.json(
          { error: "Choose a group and station." },
          { status: 400 },
        );
    }
    const settings = await loadReportBotSettings(company);
    const [live, owned, scope] = await Promise.all([
      workerRequest<{ groups: WorkerGroup[] }>(settings, "/groups", {
        timeoutMs: 30000,
      }),
      db
        .from("report_bot_groups")
        .select("id,wa_group_id,workspace,location_id,is_enabled,updated_at")
        .eq("company_id", company),
      loadCodLocations(
        company,
        auth.locationScopeIds,
        auth.hasAllLocationAccess,
      ),
    ]);
    if (!Array.isArray(live?.groups) || owned.error || scope.error)
      throw new Error();
    const stations = scope.locations.filter(
      (l) =>
        !l.is_ho &&
        !l.hide_from_location_list &&
        locationModelName(l).toUpperCase() !== "NOW",
    );
    const ownerById = new Map(
      (owned.data ?? []).map((row) => [row.wa_group_id, row]),
    );
    const groups = live.groups
      .flatMap((group) => {
        if (!/^[0-9-]+@g\.us$/.test(group.id)) return [];
        const owner = ownerById.get(group.id);
        const locations = discoveryLocations(
          group.subject || "",
          owner,
          stations,
          auth.hasAllLocationAccess,
        );
        if (!locations.length) return [];
        return [
          {
            id: group.id,
            name: group.subject || "Unnamed group",
            size: group.size,
            enabled: !!owner?.is_enabled,
            stationIds: locations.map((l) => l.id),
          },
        ];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!selection)
      return NextResponse.json(
        { groups },
        { headers: { "Cache-Control": "no-store" } },
      );
    const chosen = groups.find(
      (g) =>
        g.id === selection.group && g.stationIds.includes(selection.station),
    );
    if (!chosen)
      return NextResponse.json(
        { error: "Group or station is no longer available." },
        { status: 409 },
      );
    const owner = ownerById.get(chosen.id);
    if (owner?.is_enabled)
      return NextResponse.json(
        { error: "Group already added. Open it in Chats." },
        { status: 409 },
      );
    const values = {
      group_name: chosen.name,
      participant_count: chosen.size,
      location_id: selection.station,
      is_enabled: true,
      bot_in_group: true,
      mode: "observe",
      updated_at: new Date().toISOString(),
    };
    const write = owner
      ? await db
          .from("report_bot_groups")
          .update(values)
          .eq("id", owner.id)
          .eq("company_id", company)
          .eq("workspace", "last_mile")
          .eq("is_enabled", false)
          .eq("updated_at", owner.updated_at)
          .select("id")
          .maybeSingle()
      : await db
          .from("report_bot_groups")
          .insert({
            ...values,
            company_id: company,
            workspace: "last_mile",
            wa_group_id: chosen.id,
          })
          .select("id")
          .single();
    if (write.error || !write.data)
      return NextResponse.json(
        { error: "Could not add this group. Refresh the list and retry." },
        { status: 409 },
      );
    await pushWorkerConfig(settings);
    return NextResponse.json({ id: write.data.id });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof WorkerError
            ? e.message
            : "Could not load the WhatsApp group directory. Retry.",
      },
      { status: 503 },
    );
  }
}
export async function GET() {
  return directory();
}
export async function POST(request: Request) {
  return directory(request);
}
