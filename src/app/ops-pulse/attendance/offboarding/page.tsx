import { AppShell } from "@/components/app-shell";
import { OpsOffboardingChecklist } from "@/components/ops-offboarding-checklist";
import { requirePagePermission } from "@/lib/authorization";
import { loadOffboardingChecklist } from "@/lib/ops-pulse/offboarding-checklist-data";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export default async function OffboardingChecklistPage() {
  const auth = await requirePagePermission("ops_offboarding_checklist", "access");
  let content;
  try {
    const data = await loadOffboardingChecklist(auth);
    content = <OpsOffboardingChecklist initial={data} />;
  } catch (e) {
    content = (
      <section className="panel" style={{ padding: 24 }}>
        <h1>Offboarding Checklist</h1>
        <p role="alert">{e instanceof Error ? e.message : "Offboarding checklist could not be loaded."}</p>
      </section>
    );
  }
  return <AppShell active="Team Ops" pageCode="ops_offboarding_checklist">{content}</AppShell>;
}
