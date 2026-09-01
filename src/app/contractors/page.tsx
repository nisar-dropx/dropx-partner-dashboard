import { FieldExecutivePageContent } from "@/components/field-executive-page-content";

export default function ContractorsPage({
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
      activeLabel="Independent Contractor"
      addTitle="Add independent contractor"
      bulkImportDescription="Upload existing independent contractor rows and keep the profile completion pending for the app."
      bulkImportTitle="Bulk upload independent contractors"
      designationCategoryFilter={["contractors"]}
      detailSubtitle="Complete Independent Contractor profile"
      editId={searchParams?.edit}
      editTitle="Edit independent contractor"
      emptyListLabel="No independent contractors added yet."
      entityLabel="Independent Contractor"
      errorMessage={searchParams?.error}
      listTitle="Independent Contractor register"
      notice={searchParams?.notice}
      pageCode="contractors"
      pageSubtitle="Register and maintain independent contractors by model."
      pageTitle="Independent Contractor"
      returnPath="/contractors"
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
