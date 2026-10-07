import { AppShell } from "@/components/app-shell";
import { OpsTeamOrg } from "@/components/ops-team-org";
import { requirePagePermission } from "@/lib/authorization";
import { loadTeamOrgView } from "@/lib/ops-pulse/team-org-data";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export default async function MyTeamPage() {
  const auth = await requirePagePermission("ops_my_team", "access");
  let content;
  try {
    const view = await loadTeamOrgView(auth);
    content = <OpsTeamOrg view={view} companyName={auth.companyName ?? "Company"} />;
  } catch (e) {
    content = (
      <section className="panel" style={{ padding: 24 }}>
        <h1>My Team &amp; Org</h1>
        <p role="alert">{e instanceof Error ? e.message : "Your team could not be loaded."}</p>
        <a className="button secondary" href="/attendance/my-team">Try again</a>
      </section>
    );
  }
  return <AppShell active="Team Ops" pageCode="ops_my_team">{content}</AppShell>;
}
