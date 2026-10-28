import { AllPeopleRegister } from "@/components/all-people-register";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { OpsWorkforceNavigation } from "@/components/ops-workforce-navigation";
import { requirePagePermission, hasPermission, isCompanyOwner } from "@/lib/authorization";
import { loadCanonicalWorkforcePeople } from "@/lib/canonical-workforce-people";
import { loadOpsWorkforceLocations } from "@/lib/ops-workforce-locations";
import { requireCompanyId } from "@/lib/company-scope";
import { peopleDateKey } from "@/lib/all-people-verification-view";
import Link from "next/link";
import { filterMappingProfiles, mappingProfileLabels, type MappingProfileState } from "@/lib/mapping-profile-status";
export async function OpsWorkforcePeople({profile,ids}:{profile?:string;ids?:string} = {}) {
  const authorization = await requirePagePermission("delivery_associates", "access");
  const companyId = requireCompanyId(authorization);
  const locations = await loadOpsWorkforceLocations(companyId, authorization);
  const selectedIds = ids === undefined ? null : new Set(ids.split(",").filter(Boolean));
  const data = await loadCanonicalWorkforcePeople(companyId, locations.map(location => location.id), false, {
    canView: true, canEdit: !authorization.readOnly && hasPermission(authorization, "delivery_associates", "edit"),
    isOwner: isCompanyOwner(authorization), surface: "ops", basePath: "/work-force-register", activeOnly: false,
    selectedIds: selectedIds ? [...selectedIds] : undefined
  });
  const profileFilter = profile && Object.hasOwn(mappingProfileLabels,profile) ? profile as MappingProfileState : null;
  const rows = filterMappingProfiles(data.rows, profile, ids);
  return <AppShell active="Workforce Register" pageCode="delivery_associates">
    <PageHead eyebrow="Workforce master" title="Workforce Register" subtitle="All associate IDs for your locations, including pending and inactive records." />
    <OpsWorkforceNavigation register />
    {data.error ? <section className="panel message-panel error"><div className="panel-body">{data.error}</div></section> : null}
    {selectedIds || profileFilter ? <section className="panel"><div className="panel-body"><strong>{rows.length} {profileFilter ? mappingProfileLabels[profileFilter].toLowerCase() : "selected associates"}</strong><p className="subtle">Selected from Mapping Summary. Current profile status and your Workforce station/designation access apply.</p><Link href="/work-force-register?section=register">Clear selection</Link></div></section> : null}
    <AllPeopleRegister rows={rows} today={peopleDateKey()} registerPath="/work-force-register?section=register" />
  </AppShell>;
}
