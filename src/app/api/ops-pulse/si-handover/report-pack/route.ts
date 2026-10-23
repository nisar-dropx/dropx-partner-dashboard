import {
  isManager,
  progress,
  statusLabels,
} from "@/lib/ops-pulse/si-handover/model";
import {
  context,
  proofs,
  readChecklist,
  stores,
} from "@/lib/ops-pulse/si-handover/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const id = String(new URL(request.url).searchParams.get("id") || "").trim();
    if (!id) throw Error("Checklist id is required.");
    const c = await context();
    if (!isManager(c.actor, c.master.settings) && !c.actor.isMasterOwner) {
      return Response.json({ error: "Managers only." }, { status: 403 });
    }
    const focused = await readChecklist(id, c);
    const row = focused.checklist;
    const locations = await stores(c.auth, c.master.settings);
    const city =
      locations.find((l) => l.id === row.location_id)?.city || null;
    const p = progress(row, { city, settings: c.master.settings });
    const evidence = await proofs(c.companyId, row.id);
    return Response.json({
      kind: "shift" as const,
      editUrl: `/si-handover?view=during&id=${row.id}`,
      checklist: {
        id: row.id,
        store_code: row.store_code,
        store_name: row.store_name || row.store_code,
        shift_date: row.shift_date,
        shift_slot: row.shift_slot,
        status: row.status,
        statusLabel: statusLabels[row.status] || row.status,
        person_name: row.outgoing_name,
        incoming_name: row.incoming_name,
        started_at: row.started_at,
        updated_at: row.updated_at,
        submitted_at: row.submitted_at,
        accepted_at: row.accepted_at,
        answered: p.answered,
        total: p.total,
        pct: p.pct,
      },
      sections: (row.template?.sections || []).map((section) => ({
        id: section.id,
        name: section.name,
        tasks: (section.tasks || []).map((task) => {
          const a = row.answers?.[task.id];
          return {
            id: task.id,
            label: task.label,
            answerType: task.answerType,
            outcome: a?.outcome || "",
            numbers: a?.numbers || {},
            lines: a?.lines || [],
            text: a?.text || "",
            informed: a?.informed || "",
          };
        }),
      })),
      proofs: evidence.map((e) => ({
        id: e.id,
        task_id: e.task_id,
        content_type: e.content_type || "",
        file_name: e.file_name || "evidence",
        url: `/api/ops-pulse/si-handover/evidence/${e.id}`,
      })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unable to load report.";
    const status = /scope|unavailable|Managers|denied/i.test(message)
      ? 403
      : 400;
    return Response.json({ error: message }, { status });
  }
}
