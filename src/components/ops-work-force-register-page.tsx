import { FieldExecutivePageContent } from "@/components/field-executive-page-content";

export type WorkForceRegisterSearchParams = {
  edit?: string; error?: string; notice?: string; view?: string;
  full_name?: string; mobile_country_code?: string; mobile?: string; email?: string;
  date_of_join?: string; location_id?: string; designation?: string;
};

export function OpsWorkforceRegisterPage({ searchParams }: { searchParams?: WorkForceRegisterSearchParams }) {
  return (
    <FieldExecutivePageContent
      activeLabel="Workforce Register"
      addTitle="Request workforce onboarding"
      designationCategoryFilter={["workforce"]}
      detailSubtitle="Workforce application and profile"
      editId={searchParams?.edit}
      editTitle="Edit workforce request"
      emptyListLabel="No workforce onboarding requests or active associates yet."
      entityLabel="Workforce applicant"
      errorMessage={searchParams?.error}
      listTitle="Workforce requests and active associates"
      notice={searchParams?.notice}
      pageCode="delivery_associates"
      pageTitle="Workforce Register"
      returnPath="/work-force-register"
      viewId={searchParams?.view}
      addFormValues={{ fullName: searchParams?.full_name, mobileCountryCode: searchParams?.mobile_country_code, mobile: searchParams?.mobile, email: searchParams?.email, dateOfJoin: searchParams?.date_of_join, locationId: searchParams?.location_id, designation: searchParams?.designation }}
    />
  );
}
