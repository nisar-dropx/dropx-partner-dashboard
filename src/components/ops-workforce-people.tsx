import { AllPeopleRegister } from "@/components/all-people-register";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { OpsWorkforceNavigation } from "@/components/ops-workforce-navigation";
import { requirePagePermission, hasPermission, isCompanyOwner } from "@/lib/authorization";
import { loadCanonicalWorkforcePeople } from "@/lib/canonical-workforce-people";
import { loadOpsWorkforceLocations } from "@/lib/ops-workforce-locations";
import { requireCompanyId } from "@/lib/company-scope";
import { peopleDateKey } from "@/lib/all-people-verification-view";
export async function OpsWorkforcePeople() {
  const authorization = await requirePagePermission("delivery_associates", "access");
  const companyId = requireCompanyId(authorization);
  const locations = await loadOpsWorkforceLocations(companyId, authorization);
  const data = await loadCanonicalWorkforcePeople(companyId, locations.map(location => location.id), false, {
    canView: true, canEdit: !authorization.readOnly && hasPermission(authorization, "delivery_associates", "edit"),
    isOwner: isCompanyOwner(authorization), surface: "ops", basePath: "/work-force-register", activeOnly: false
  });
  return <AppShell active="Workforce Register" pageCode="delivery_associates">
    <PageHead eyebrow="Workforce master" title="Workforce Register" subtitle="All associate IDs for your locations, including pending and inactive records." />
    <OpsWorkforceNavigation register />
    {data.error ? <section className="panel message-panel error"><div className="panel-body">{data.error}</div></section> : null}
    <AllPeopleRegister rows={data.rows} today={peopleDateKey()} registerPath="/work-force-register?section=register" />
  </AppShell>;
}
