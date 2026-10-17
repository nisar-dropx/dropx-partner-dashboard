import { AppShell } from "@/components/app-shell";
import { WorkforceHoldsDesk } from "@/components/workforce-holds-desk";
import { requirePagePermission } from "@/lib/authorization";
import { loadWorkforceHoldWorkspace } from "@/lib/ops-pulse/workforce-hold-data";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function WorkforceHolds() {
  const auth = await requirePagePermission("ops_salary_hold", "access");
  let content;
  try {
    content = <WorkforceHoldsDesk initial={await loadWorkforceHoldWorkspace(auth)} />;
  } catch (e) {
    content = <section className="panel" style={{ padding: 24 }}><h1>Workforce payment holds</h1><p role="alert">{e instanceof Error ? e.message : "Workforce holds could not be loaded."}</p></section>;
  }
  return <AppShell active="Team Ops" pageCode="ops_salary_hold">{content}</AppShell>;
}
