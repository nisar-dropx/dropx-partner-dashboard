import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { resolveActivitiesNavAccess } from "@/lib/ops-pulse/activities-nav-access";
import {
  todayIst,
  type WorkspaceView,
} from "@/lib/ops-pulse/store-ops/model";
import {
  context,
  listChecklists,
  periodCompletions,
  proofs,
  readChecklist,
} from "@/lib/ops-pulse/store-ops/server";
import { StoreOpsWorkspace } from "./workspace";

export const dynamic = "force-dynamic";

function parseView(v?: string): WorkspaceView {
  if (v === "midday" || v === "compliance" || v === "close" || v === "start")
    return v;
  return "start";
}

export default async function Page({
  searchParams,
}: {
  searchParams?: { view?: string; id?: string; from?: string; to?: string };
}) {
  const auth = await requirePagePermission("store_ops", "access");
  const c = await context();
  const nav = await resolveActivitiesNavAccess(auth);
  if (!nav.showStoreOps) {
    redirect("/unauthorized?page=store_ops&reason=access");
  }
  const view = parseView(searchParams?.view);
  const today = todayIst();
  const from = searchParams?.from || (() => {
    const d = new Date(`${today}T12:00:00+05:30`);
    d.setDate(d.getDate() - 13);
    return d.toISOString().slice(0, 10);
  })();
  const to = searchParams?.to || today;
  const { locations, rows } = await listChecklists(c.auth, c.master, {
    from,
    to,
    status: ["open", "submitted"],
  });
  let focused = null;
  let error = "";
  let weeklyDoneIds: string[] = [];
  let monthlyDoneIds: string[] = [];
  if (searchParams?.id) {
    try {
      const read = await readChecklist(searchParams.id, c);
      focused = read.checklist;
      const period = await periodCompletions(
        c.companyId,
        focused.location_id,
        focused.work_date,
        focused.id,
      );
      weeklyDoneIds = [...period.weeklyDone];
      monthlyDoneIds = [...period.monthlyDone];
    } catch {
      error = "This checklist is unavailable in your store scope.";
    }
  }
  const evidence = focused ? await proofs(c.companyId, focused.id) : [];

  return (
    <AppShell active="Store operations" pageCode="store_ops">
      <StoreOpsWorkspace
        key={`${focused?.id || "list"}:${view}`}
        view={view}
        stores={locations}
        rows={rows}
        focused={focused}
        evidence={evidence}
        actor={c.actor}
        settings={c.master.settings}
        error={error}
        weeklyDoneIds={weeklyDoneIds}
        monthlyDoneIds={monthlyDoneIds}
        showShiftOps={nav.showShiftOps}
        showShiftReport={nav.showShiftReport}
        showStoreReport={nav.showStoreReport}
      />
    </AppShell>
  );
}
