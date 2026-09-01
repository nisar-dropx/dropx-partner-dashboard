import { AllPeopleRegister } from "@/components/all-people-register";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { loadCanonicalWorkforcePeople } from "@/lib/canonical-workforce-people";
import { requireCompanyId } from "@/lib/company-scope";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function WorkforcePage() {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  if (!hasPermission(authorization, "people_all", "access")) redirect("/unauthorized?page=people_all&action=access");

  const data = await loadCanonicalWorkforcePeople(
    requireCompanyId(authorization),
    authorization.locationScopeIds,
    authorization.hasAllLocationAccess,
    {
      canView: hasPermission(authorization, "delivery_associates", "access"),
      canEdit: hasPermission(authorization, "delivery_associates", "edit")
    }
  );

  return (
    <AppShell active="Workforce" pageCode="people_all">
      <PageHead eyebrow="People" title="Workforce" subtitle="View canonical workforce records stored in the Workforce register." />
      {data.error ? (
        <section className="panel message-panel error"><div className="panel-body"><strong>Unable to load workforce</strong><p className="subtle">{data.error}</p></div></section>
      ) : null}
      <AllPeopleRegister rows={data.rows} />
    </AppShell>
  );
}
