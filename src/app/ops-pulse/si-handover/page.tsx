import { AppShell } from "@/components/app-shell";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import {
  currentShift,
  type WorkspaceView,
} from "@/lib/ops-pulse/si-handover/model";
import {
  context,
  listChecklists,
  proofs,
  readChecklist,
} from "@/lib/ops-pulse/si-handover/server";
import { SiHandoverWorkspace } from "./workspace";

export const dynamic = "force-dynamic";

function parseView(v?: string): WorkspaceView {
  if (v === "during" || v === "handover" || v === "accept" || v === "start")
    return v;
  return "start";
}

export default async function Page({
  searchParams,
}: {
  searchParams?: { view?: string; id?: string; from?: string; to?: string };
}) {
  await requirePagePermission("si_handover", "access");
  const c = await context();
  const view = parseView(searchParams?.view);
  const cur = currentShift(new Date(), c.master.settings.shiftSlots);
  const lookbackStart = (() => {
    const d = new Date(`${cur.shiftDate}T12:00:00+05:30`);
    d.setDate(d.getDate() - 2);
    return d.toISOString().slice(0, 10);
  })();
  const from = searchParams?.from || lookbackStart;
  const to = searchParams?.to || cur.shiftDate;
  const status =
    view === "accept"
      ? ["submitted"]
      : ["open", "submitted", "rejected", "accepted"];
  const { locations, rows } = await listChecklists(c.auth, c.master, {
    from,
    to,
    status,
  });
  let focused = null;
  let error = "";
  if (searchParams?.id) {
    try {
      focused = (await readChecklist(searchParams.id, c)).checklist;
    } catch {
      error = "This checklist is unavailable in your store scope.";
    }
  }
  const evidence = focused ? await proofs(c.companyId, focused.id) : [];
  return (
    <AppShell
      active={
        view === "accept"
          ? "Acceptance"
          : view === "handover"
            ? "Station Handover"
            : "Start Shift"
      }
      pageCode="si_handover"
    >
      <SiHandoverWorkspace
        key={`${focused?.id || "list"}:${view}`}
        view={view}
        stores={locations}
        rows={rows}
        focused={focused}
        evidence={evidence}
        actor={c.actor}
        settings={c.master.settings}
        error={error}
        canMaster={hasPermission(c.auth, "si_handover_master", "access")}
      />
    </AppShell>
  );
}
