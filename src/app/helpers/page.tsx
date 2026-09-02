import { FieldExecutivePageContent } from "@/components/field-executive-page-content";

export default function HelpersPage({ searchParams }: { searchParams?: { edit?: string; error?: string; notice?: string; view?: string; full_name?: string; mobile_country_code?: string; mobile?: string; email?: string; date_of_join?: string; location_id?: string; designation?: string } }) {
  return <FieldExecutivePageContent
    activeLabel="Helpers"
    addTitle="Add helper"
    bulkImportDescription="Upload existing helper rows and keep profile completion pending for DropX One."
    bulkImportTitle="Bulk upload helpers"
    designationCategoryFilter={["workers"]}
    detailSubtitle="Complete helper profile"
    editId={searchParams?.edit}
    editTitle="Edit helper"
    emptyListLabel="No helpers added yet."
    entityLabel="Helper"
    errorMessage={searchParams?.error}
    listTitle="Helper register"
    notice={searchParams?.notice}
    pageCode="workers"
    pageSubtitle="Register and maintain helpers by location."
    pageTitle="Helpers"
    returnPath="/helpers"
    viewId={searchParams?.view}
    addFormValues={{ fullName: searchParams?.full_name, mobileCountryCode: searchParams?.mobile_country_code, mobile: searchParams?.mobile, email: searchParams?.email, dateOfJoin: searchParams?.date_of_join, locationId: searchParams?.location_id, designation: searchParams?.designation }}
  />;
}
