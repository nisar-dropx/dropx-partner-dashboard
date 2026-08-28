import { FieldExecutivePageContent } from "@/components/field-executive-page-content";
import { PendingLink } from "@/components/pending-link";

export type WorkForceRegisterSearchParams = {
  edit?: string; error?: string; notice?: string; view?: string;
  full_name?: string; mobile_country_code?: string; mobile?: string; email?: string;
  date_of_join?: string; location_id?: string; designation?: string;
};

type RegisterCategory = "contractors" | "helpers" | "vendors";

const categoryConfig = {
  contractors: { addTitle: "Add independent contractor", category: "contractors" as const, detailSubtitle: "Complete Independent Contractor profile", editTitle: "Edit independent contractor", emptyLabel: "No independent contractors added yet.", entityLabel: "Independent Contractor", listTitle: "Independent Contractor register", returnPath: "/work-force-register" as const },
  helpers: { addTitle: "Add helper", category: "workers" as const, detailSubtitle: "Complete helper profile", editTitle: "Edit helper", emptyLabel: "No helpers added yet.", entityLabel: "Helper", listTitle: "Helper register", returnPath: "/work-force-register/helpers" as const },
  vendors: { addTitle: "Add vendor", category: "vendors" as const, detailSubtitle: "Complete vendor profile", editTitle: "Edit vendor", emptyLabel: "No vendors added yet.", entityLabel: "Vendor", listTitle: "Vendor register", returnPath: "/work-force-register/vendors" as const }
};

export function RegisterNavigation({ active }: { active: RegisterCategory }) {
  return (
    <nav className="tabs" aria-label="Work force categories">
      <PendingLink className={`tab${active === "contractors" ? " active" : ""}`} href="/work-force-register">Independent Contractors</PendingLink>
      <PendingLink className={`tab${active === "helpers" ? " active" : ""}`} href="/work-force-register/helpers">Helpers</PendingLink>
      <PendingLink className={`tab${active === "vendors" ? " active" : ""}`} href="/work-force-register/vendors">Vendors</PendingLink>
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
      notice={searchParams?.notice} pageCode={config.category}
      pageSubtitle="Onboard and maintain independent contractors, helpers, and vendors. Only OPS-enabled designations are available."
      pageTitle="Work Force Register" registerNavigation={<RegisterNavigation active={category} />}
      returnPath={config.returnPath} viewId={searchParams?.view}
      addFormValues={{ fullName: searchParams?.full_name, mobileCountryCode: searchParams?.mobile_country_code, mobile: searchParams?.mobile, email: searchParams?.email, dateOfJoin: searchParams?.date_of_join, locationId: searchParams?.location_id, designation: searchParams?.designation }}
    />
  );
}
