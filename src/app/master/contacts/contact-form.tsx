import { SubmitButton } from "@/components/submit-button";

type Contact = {
  id: string;
  contact_no: string | null;
  email: string | null;
  bank_account_no: string | null;
  ifsc: string | null;
  upi_id: string | null;
  account_holder_name: string;
};

export function ContactForm({ action, contact, submitLabel = "Add contact" }: {
  action: (formData: FormData) => void;
  contact?: Contact | null;
  submitLabel?: string;
}) {
  return (
    <form action={action} className="panel-body">
      {contact ? <input name="id" type="hidden" value={contact.id} /> : null}
      <div className="form-grid three">
        <label>Account holder name *<input className="field" defaultValue={contact?.account_holder_name ?? ""} name="account_holder_name" required /></label>
        {contact?.upi_id ? <label>UPI ID<input className="field" defaultValue={contact.upi_id} name="upi_id" readOnly /></label> : <>
          <label>Bank account no *<input className="field" defaultValue={contact?.bank_account_no ?? ""} name="bank_account_no" required /></label>
          <label>IFSC *<input className="field" defaultValue={contact?.ifsc ?? ""} maxLength={11} name="ifsc" required /></label>
        </>}
        <label>Contact no<input className="field" defaultValue={contact?.contact_no ?? ""} name="contact_no" type="tel" /></label>
        <label>Email<input className="field" defaultValue={contact?.email ?? ""} name="email" type="email" /></label>
      </div>
      <div className="form-actions"><SubmitButton>{submitLabel}</SubmitButton></div>
    </form>
  );
}
