import {
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
    // readChecklist enforces company, page permission and current store scope.
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
        notes: row.open_issues || "",
      },
      sections: (row.template?.sections || []).map((section) => ({
        id: section.id,
        name: section.name,
        tasks: (section.tasks || []).map((task) => {
          const a = row.answers?.[task.id];
          const taskProgress = progress({template:{...row.template,sections:[{...section,tasks:[task]}]},answers:row.answers}, {city,settings:c.master.settings});
          return {
            id: task.id,
            label: task.label,
            answerType: task.answerType,
            outcome: a?.outcome || "",
            numbers: a?.numbers || {},
            fieldLabels: Object.fromEntries((task.numberFields || []).map(f => [f.key, f.label])),
            lines: a?.lines || [],
            text: a?.text || "",
            informed: a?.informed || "",
            recordStatus: taskProgress.total && !taskProgress.answered ? "Not recorded" : ["no", "issue", "fail"].includes(a?.outcome || "") ? "Needs attention" : taskProgress.answered ? "Recorded" : "Optional / not required",
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
