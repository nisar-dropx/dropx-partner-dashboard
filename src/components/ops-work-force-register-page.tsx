import { FieldExecutivePageContent } from "@/components/field-executive-page-content";
import { PendingLink } from "@/components/pending-link";

export type WorkForceRegisterSearchParams = {
  edit?: string; error?: string; notice?: string; view?: string;
  full_name?: string; mobile_country_code?: string; mobile?: string; email?: string;
  date_of_join?: string; location_id?: string; designation?: string;
};

type RegisterCategory = "workforce" | "helpers";

const categoryConfig = {
  workforce: { addTitle: "Request workforce onboarding", category: "workforce" as const, detailSubtitle: "Workforce application and profile", editTitle: "Edit workforce request", emptyLabel: "No workforce onboarding requests yet.", entityLabel: "Workforce applicant", listTitle: "Workforce onboarding requests", pageCode: "delivery_associates" as const, returnPath: "/work-force-register" as const },
  helpers: { addTitle: "Add helper", category: "workers" as const, detailSubtitle: "Complete helper profile", editTitle: "Edit helper", emptyLabel: "No helpers added yet.", entityLabel: "Helper", listTitle: "Helper register", pageCode: "workers" as const, returnPath: "/work-force-register/helpers" as const }
};

export function RegisterNavigation({ active }: { active: RegisterCategory }) {
  return (
    <nav className="tabs" aria-label="Work force categories">
      <PendingLink className={`tab${active === "workforce" ? " active" : ""}`} href="/work-force-register">Workforce</PendingLink>
      <PendingLink className={`tab${active === "helpers" ? " active" : ""}`} href="/work-force-register/helpers">Helpers</PendingLink>
    </nav>
  );
}

export function WorkForceRegisterCategoryPage({ category, searchParams }: { category: RegisterCategory; searchParams?: WorkForceRegisterSearchParams }) {
  const config = categoryConfig[category];
  return (
    <FieldExecutivePageContent
      activeLabel="Work Force Register" addTitle={config.addTitle}
      designationCategoryFilter={[config.category]} detailSubtitle={config.detailSubtitle}
      editId={searchParams?.edit} editTitle={config.editTitle} emptyListLabel={config.emptyLabel}
      entityLabel={config.entityLabel} errorMessage={searchParams?.error} listTitle={config.listTitle}
      notice={searchParams?.notice} pageCode={config.pageCode}
      pageSubtitle="Onboard and maintain workforce and helpers. Only OPS-enabled designations are available."
      pageTitle="Work Force Register" registerNavigation={<RegisterNavigation active={category} />}
      returnPath={config.returnPath} viewId={searchParams?.view}
      addFormValues={{ fullName: searchParams?.full_name, mobileCountryCode: searchParams?.mobile_country_code, mobile: searchParams?.mobile, email: searchParams?.email, dateOfJoin: searchParams?.date_of_join, locationId: searchParams?.location_id, designation: searchParams?.designation }}
    />
  );
}
