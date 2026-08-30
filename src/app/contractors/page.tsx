import { FieldExecutivePageContent } from "@/components/field-executive-page-content";
import { PendingLink } from "@/components/pending-link";
import { contractorRegisterViewFrom } from "@/lib/contractor-register-visibility";

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
    records?: string;
  };
}) {
  const recordView = contractorRegisterViewFrom(searchParams?.records);
  const viewCopy = recordView === "compatibility"
    ? {
        empty: "No Workforce compatibility records found.",
        list: "Legacy Workforce compatibility",
        subtitle: "Read-only contractor source rows retained for registration, history, and DropX One compatibility."
      }
    : recordView === "inactive"
      ? {
          empty: "No inactive independent contractors found.",
          list: "Inactive independent contractors",
          subtitle: "Review genuine inactive independent-contractor records. Workforce compatibility rows are kept separately."
        }
      : {
          empty: "No active independent contractors found.",
          list: "Active independent contractors",
          subtitle: "Register and maintain current independent contractors. Workforce compatibility rows are excluded."
        };

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
      emptyListLabel={viewCopy.empty}
      entityLabel="Independent Contractor"
      errorMessage={searchParams?.error}
      listTitle={viewCopy.list}
      notice={searchParams?.notice}
      pageCode="contractors"
      pageSubtitle={viewCopy.subtitle}
      pageTitle="Independent Contractor"
      returnPath="/contractors"
      recordView={recordView}
      registerNavigation={(
        <nav className="tabs" aria-label="Independent contractor record views">
          <PendingLink className={`tab${recordView === "active" ? " active" : ""}`} href="/contractors">Active</PendingLink>
          <PendingLink className={`tab${recordView === "inactive" ? " active" : ""}`} href="/contractors?records=inactive">Inactive</PendingLink>
          <PendingLink className={`tab${recordView === "compatibility" ? " active" : ""}`} href="/contractors?records=compatibility">Legacy compatibility</PendingLink>
        </nav>
      )}
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
