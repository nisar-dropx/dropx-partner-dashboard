import { FieldExecutivePageContent } from "@/components/field-executive-page-content";
import { OpsWorkforcePeople } from "@/components/ops-workforce-people";
import { OpsWorkforceNavigation } from "@/components/ops-workforce-navigation";
export type WorkForceRegisterSearchParams = {
  section?: string; edit?: string; view?: string; error?: string; notice?: string;
  full_name?: string; mobile_country_code?: string; mobile?: string; email?: string;
  date_of_join?: string; reported_on?: string; location_id?: string; designation?: string;
};
export function OpsWorkforceRegisterPage({ searchParams = {} }: { searchParams?: WorkForceRegisterSearchParams }) {
  if (searchParams.section === "register" && !searchParams.edit && !searchParams.view) return <OpsWorkforcePeople />;
  return <FieldExecutivePageContent
    activeLabel="Workforce Register" pageCode="delivery_associates" pageTitle="Workforce Register"
    pageSubtitle="Invite associates and follow their registration progress."
    addTitle="Request workforce onboarding" listTitle="Workforce onboarding requests"
    entityLabel="Workforce applicant" emptyListLabel="No workforce onboarding requests yet."
    detailSubtitle="Workforce application and profile" editTitle="Edit workforce request"
    designationCategoryFilter={["workforce"]} returnPath="/work-force-register"
    registerNavigation={<OpsWorkforceNavigation />} errorMessage={searchParams.error} notice={searchParams.notice}
    editId={searchParams.edit} viewId={searchParams.view}
    addFormValues={{ fullName: searchParams.full_name, mobileCountryCode: searchParams.mobile_country_code,
      mobile: searchParams.mobile, email: searchParams.email, dateOfJoin: searchParams.date_of_join,
      reportedOn: searchParams.reported_on, locationId: searchParams.location_id, designation: searchParams.designation }}
  />;
}
