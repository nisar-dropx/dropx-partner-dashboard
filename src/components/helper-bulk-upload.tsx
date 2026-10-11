import { bulkImportFieldExecutives } from "@/app/field-executive/actions";
import { SubmitButton } from "@/components/submit-button";

export function HelperBulkUpload() {
  return (
    <section className="panel workforce-bulk-panel">
      <div className="panel-head">
        <div>
          <h2>Bulk upload existing helpers</h2>
          <p className="subtle">
            Add Helpers who are already working with DropX. Imported Helpers are activated immediately; saved profiles are never overwritten.
          </p>
        </div>
      </div>
      <form action={bulkImportFieldExecutives} className="workforce-bulk-form">
        <input name="return_path" type="hidden" value="/helpers" />
        <div className="workforce-template-note">
          <strong>Helper upload template</strong>
          <span>Download the prepared Excel, fill up to 200 new Helpers per file, then upload it. Keep bank account cells formatted as Text.</span>
          <a className="template-download-link" download href="/api/import-template?kind=helper">
            Download Helper Excel
          </a>
        </div>
        <input accept=".xlsx,.xls,.csv" className="field" name="bulk_file" required type="file" />
        <SubmitButton
          confirmCancelText="No"
          confirmDescription="This adds and activates new Helper profiles. Any duplicate saved identity is rejected instead of updated."
          confirmMessage="Import the Helper records from this file?"
          confirmSubmitText="Yes, upload"
          confirmTitle="Confirm Helper bulk upload"
          pendingText="Uploading"
        >
          Upload helpers
        </SubmitButton>
      </form>
    </section>
  );
}
