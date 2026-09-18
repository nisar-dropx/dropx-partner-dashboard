import { AppShell } from "@/components/app-shell";
import { OpsSalaryHold } from "@/components/ops-salary-hold";
import { requirePagePermission } from "@/lib/authorization";
import { loadSalaryHoldWorkspace } from "@/lib/ops-pulse/salary-hold-data";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export default async function SalaryHoldPage() {
  const auth = await requirePagePermission("ops_salary_hold", "access");
  let content;
  try {
    const data = await loadSalaryHoldWorkspace(auth);
    content = <OpsSalaryHold initial={data} />;
  } catch (e) {
    content = (
      <section className="panel" style={{ padding: 24 }}>
        <h1>Salary Hold</h1>
        <p role="alert">{e instanceof Error ? e.message : "Salary hold workspace could not be loaded."}</p>
      </section>
    );
  }
  return <AppShell active="Team Ops" pageCode="ops_salary_hold">{content}</AppShell>;
}
