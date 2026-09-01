import { FieldExecutivePageContent } from "@/components/field-executive-page-content";

export default function FieldExecutivePage({
  searchParams
}: {
  searchParams?: {
    edit?: string;
    error?: string;
    notice?: string;
    view?: string;
    full_name?: string;
    mobile_country_code?: string;
    mobile?: string;
    email?: string;
    date_of_join?: string;
    location_id?: string;
    designation?: string;
  };
}) {
  return (
    <FieldExecutivePageContent
      activeLabel="Workforce Onboarding"
      addTitle="Request workforce onboarding"
      bulkImportDescription="Upload workforce onboarding requests. Every applicant remains pending until profile submission, agreement acceptance and HO activation."
      bulkImportTitle="Bulk onboarding requests"
      designationCategoryFilter={["workforce"]}
      detailSubtitle="Workforce application and profile"
      editId={searchParams?.edit}
      editTitle="Edit workforce request"
      emptyListLabel="No workforce onboarding requests yet."
      entityLabel="Workforce applicant"
      errorMessage={searchParams?.error}
      listTitle="Workforce onboarding requests"
      notice={searchParams?.notice}
      pageCode="delivery_associates"
      pageSubtitle="Create DA/DCD/ODCD requests and track them through candidate submission and HO activation."
      pageTitle="Workforce Onboarding"
      returnPath="/field-executive"
      viewId={searchParams?.view}
      addFormValues={{
        fullName: searchParams?.full_name,
        mobileCountryCode: searchParams?.mobile_country_code,
        mobile: searchParams?.mobile,
        email: searchParams?.email,
        dateOfJoin: searchParams?.date_of_join,
        locationId: searchParams?.location_id,
        designation: searchParams?.designation
      }}
    />
  );
}
