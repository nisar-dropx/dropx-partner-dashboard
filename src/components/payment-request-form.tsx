"use client";

import { useEffect, useMemo, useState } from "react";
import { AutoGrowTextarea } from "@/components/auto-grow-textarea";
import { SearchableSelect, type SearchableSelectOption } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";
import { paymentFileAccept, paymentFileGroupLabels } from "@/lib/payment-file-types";
import type { UserPaymentContact } from "@/lib/payment-contacts";
import { PAYMENT_MODES, normalizePaymentModes, type PaymentMode } from "@/lib/payment-modes";

type PaymentQuestion = {
  id: string;
  question_text: string;
  answer_type: string;
  dropdown_options: string | null;
  is_required: boolean;
};

type PaymentHead = {
  id: string;
  code: string;
  name: string;
  requires_supporting_document: boolean;
  request_expense_approval?: boolean | null;
  expense_approval_threshold?: number | null;
  supported_payment_modes?: PaymentMode[] | null;
  payment_head_questions: PaymentQuestion[];
};

type PaymentRequestFormProps = {
  action: (formData: FormData) => void;
  amountLabel?: string;
  headOptions: SearchableSelectOption[];
  heads: PaymentHead[];
  locationOptions: SearchableSelectOption[];
  savedContacts?: UserPaymentContact[];
  showBankDetails?: boolean;
  submitLabel?: string;
};

function inputForQuestion(question: PaymentQuestion, disabled = false) {
  const name = `answers[${question.id}]`;
  if (question.answer_type === "dropdown") {
    const options = (question.dropdown_options ?? "")
      .split(",")
      .map((option) => option.trim())
      .filter(Boolean);
    return (
      <select className="field" disabled={disabled} name={name} required={question.is_required}>
        <option value="">Select</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  }
  if (question.answer_type === "textarea") {
    return <AutoGrowTextarea disabled={disabled} name={name} required={question.is_required} rows={3} />;
  }
  if (question.answer_type === "yes_no") {
    return (
      <select className="field" disabled={disabled} name={name} required={question.is_required}>
        <option value="">Select</option>
        <option value="Yes">Yes</option>
        <option value="No">No</option>
      </select>
    );
  }
  if (question.answer_type === "file") {
    return (
      <>
        <input
          accept={paymentFileAccept(question.dropdown_options)}
          className="field"
          disabled={disabled}
          name={`files[${question.id}]`}
          required={question.is_required}
          type="file"
        />
        <span className="helper-text">Allowed: {paymentFileGroupLabels(question.dropdown_options).join(", ")}</span>
      </>
    );
  }
  return (
    <input
      className="field"
      disabled={disabled}
      name={name}
      required={question.is_required}
      step={question.answer_type === "number" ? "0.01" : undefined}
      type={question.answer_type === "number" ? "number" : question.answer_type === "date" ? "date" : "text"}
    />
  );
}

export function PaymentRequestForm({
  action,
  amountLabel = "Amount",
  headOptions,
  heads,
  locationOptions,
  savedContacts = [],
  showBankDetails = true,
  submitLabel = "Submit request"
}: PaymentRequestFormProps) {
  const [selectedHeadId, setSelectedHeadId] = useState("");
  const [amountText, setAmountText] = useState("");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("account_transfer");
  const [bankAccountNo, setBankAccountNo] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [accountHolderName, setAccountHolderName] = useState("");
  const [contactNo, setContactNo] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [bankVerified, setBankVerified] = useState(false);
  const [bankVerificationMessage, setBankVerificationMessage] = useState("");
  const [bankVerifying, setBankVerifying] = useState(false);
  const [upiId, setUpiId] = useState("");
  const [upiVerified, setUpiVerified] = useState(false);
  const [upiVerifying, setUpiVerifying] = useState(false);
  const [upiAccountHolderName, setUpiAccountHolderName] = useState("");
  const selectedHead = useMemo(() => heads.find((head) => head.id === selectedHeadId) ?? null, [heads, selectedHeadId]);
  const supportedPaymentModes = useMemo(() => normalizePaymentModes(selectedHead?.supported_payment_modes), [selectedHead]);
  const bankContacts = useMemo(() => savedContacts.filter((contact) => contact.bank_account_no && contact.ifsc), [savedContacts]);
  const upiContacts = useMemo(() => savedContacts.filter((contact) => contact.upi_id), [savedContacts]);
  const amount = Number(amountText);
  const hasAmount = amountText.trim().length > 0 && Number.isFinite(amount);
  const expenseApprovalThreshold = selectedHead?.expense_approval_threshold ?? null;
  const blockedByExpenseApproval = showBankDetails && Boolean(selectedHead?.request_expense_approval) && (
    expenseApprovalThreshold == null || (hasAmount && amount > Number(expenseApprovalThreshold))
  );
  const isOnlinePayment = showBankDetails && paymentMode === "online_payment";
  const isUpiPayment = showBankDetails && paymentMode === "upi_payment";

  useEffect(() => {
    const firstSupportedMode = supportedPaymentModes[0];
    if (firstSupportedMode && !supportedPaymentModes.includes(paymentMode)) setPaymentMode(firstSupportedMode);
  }, [paymentMode, supportedPaymentModes]);

  async function verifyBankAccount() {
    setBankVerifying(true);
    setBankVerificationMessage("");
    try {
      const response = await fetch("/api/payments/bank-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankAccountNo, ifsc, contactNo, email: contactEmail })
      });
      const result = await response.json();
      if (!response.ok || !result.verified) throw new Error(result.error || result.message || "Bank verification failed.");
      setAccountHolderName(result.accountHolderName || "");
      setBankVerified(true);
      setBankVerificationMessage(result.source === "contact" ? "Verified account found in Contacts." : "Bank account verified.");
    } catch (error) {
      setBankVerified(false);
      setAccountHolderName("");
      setBankVerificationMessage(error instanceof Error ? error.message : "Bank verification failed.");
    } finally {
      setBankVerifying(false);
    }
  }

  function invalidateBankVerification() {
    setBankVerified(false);
    setAccountHolderName("");
    setBankVerificationMessage("");
  }

  async function verifyUpiId() {
    setUpiVerifying(true);
    setBankVerificationMessage("");
    try {
      const response = await fetch("/api/payments/upi-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upiId, contactNo, email: contactEmail })
      });
      const result = await response.json();
      if (!response.ok || !result.verified) throw new Error(result.error || result.message || "UPI verification failed.");
      setUpiAccountHolderName(result.accountHolderName || "");
      setUpiVerified(true);
      setBankVerificationMessage(result.source === "contact" ? "Verified UPI ID found in Contacts." : "UPI ID verified.");
    } catch (error) {
      setUpiVerified(false);
      setUpiAccountHolderName("");
      setBankVerificationMessage(error instanceof Error ? error.message : "UPI verification failed.");
    } finally {
      setUpiVerifying(false);
    }
  }

  function selectBankContact(contactId: string) {
    const contact = bankContacts.find((item) => item.id === contactId);
    if (!contact) return;
    setBankAccountNo(contact.bank_account_no ?? "");
    setIfsc(contact.ifsc ?? "");
    setAccountHolderName(contact.account_holder_name);
    setContactNo(contact.contact_no ?? "");
    setContactEmail(contact.email ?? "");
    setBankVerified(true);
    setBankVerificationMessage("Verified bank contact selected.");
  }

  function selectUpiContact(contactId: string) {
    const contact = upiContacts.find((item) => item.id === contactId);
    if (!contact) return;
    setUpiId(contact.upi_id ?? "");
    setUpiAccountHolderName(contact.account_holder_name);
    setContactNo(contact.contact_no ?? "");
    setContactEmail(contact.email ?? "");
    setUpiVerified(true);
    setBankVerificationMessage("Verified UPI contact selected.");
  }

  return (
    <form action={action} className="panel-body" encType="multipart/form-data">
      <div className="form-grid three">
        <label>
          Location
          <SearchableSelect name="location_id" options={locationOptions} placeholder="Select location" required />
        </label>
        <label>
          Payment Head
          <SearchableSelect name="payment_head_id" options={headOptions} placeholder="Select payment head" required onValueChange={setSelectedHeadId} />
        </label>
        <label>
          {amountLabel}
          <input className="field" min="0" name="amount" onChange={(event) => setAmountText(event.target.value)} placeholder="0.00" required step="0.01" type="number" value={amountText} />
        </label>
      </div>
      {blockedByExpenseApproval ? <p className="payment-form-warning" role="alert">Required Expense Approval</p> : null}
      {showBankDetails ? (
        <>
          <div className="payment-mode-switch" role="radiogroup" aria-label="Payment mode">
            {PAYMENT_MODES.filter((option) => supportedPaymentModes.includes(option.value)).map((option) => (
              <label key={option.value} className={paymentMode === option.value ? "active" : undefined}>
                <input
                  checked={paymentMode === option.value}
                  disabled={blockedByExpenseApproval}
                  name="payment_mode"
                  onChange={() => setPaymentMode(option.value)}
                  type="radio"
                  value={option.value}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          {isOnlinePayment ? (
            <div className="form-grid two">
              <label>
                Payment Portal *
                <input className="field" disabled={blockedByExpenseApproval} name="payment_portal" required />
              </label>
              <label>
                Reference ID / Service Number / Consumer ID
                <input className="field" disabled={blockedByExpenseApproval} name="payment_reference" placeholder="Optional" />
              </label>
              <label>
                Contact No
                <input className="field" disabled={blockedByExpenseApproval} name="contact_no" onChange={(event) => setContactNo(event.target.value)} placeholder="Optional" type="tel" value={contactNo} />
              </label>
              <label>
                Email
                <input className="field" disabled={blockedByExpenseApproval} name="email" onChange={(event) => setContactEmail(event.target.value)} placeholder="Optional" type="email" value={contactEmail} />
              </label>
            </div>
          ) : isUpiPayment ? (
            <div className="form-grid three">
              <label className="span-3">
                Saved UPI Contact
                <SearchableSelect
                  disabled={blockedByExpenseApproval || !upiContacts.length}
                  name="saved_upi_contact_id"
                  onValueChange={selectUpiContact}
                  options={upiContacts.map((contact) => ({ value: contact.id, label: contact.account_holder_name, helper: [contact.upi_id, contact.contact_no, contact.email].filter(Boolean).join(" · ") }))}
                  placeholder={upiContacts.length ? "Search your saved UPI contacts" : "No saved UPI contacts"}
                />
              </label>
              <label>
                UPI ID *
                <span className="field-with-action">
                  <input className="field" disabled={blockedByExpenseApproval} name="upi_id" onChange={(event) => { setUpiId(event.target.value.replace(/\s/g, "").toLowerCase()); setUpiVerified(false); setUpiAccountHolderName(""); setBankVerificationMessage(""); }} required placeholder="name@bank" value={upiId} />
                  <button className="button secondary compact" disabled={blockedByExpenseApproval || upiVerifying || !upiId || upiVerified} onClick={verifyUpiId} type="button">{upiVerifying ? "Verifying..." : upiVerified ? "Verified" : "Verify"}</button>
                </span>
                {bankVerificationMessage ? <span className={upiVerified ? "verification-message success" : "verification-message error"}>{bankVerificationMessage}</span> : null}
              </label>
              <label>
                Account Holder Name *
                <input className="field" name="upi_account_holder_name" readOnly required value={upiAccountHolderName} />
                <input name="upi_verified" type="hidden" value={upiVerified ? "1" : "0"} />
              </label>
              <label>
                Contact No
                <input className="field" disabled={blockedByExpenseApproval} name="contact_no" onChange={(event) => setContactNo(event.target.value)} placeholder="Optional" type="tel" value={contactNo} />
              </label>
              <label>
                Email
                <input className="field" disabled={blockedByExpenseApproval} name="email" onChange={(event) => setContactEmail(event.target.value)} placeholder="Optional" type="email" value={contactEmail} />
              </label>
            </div>
          ) : (
            <div className="form-grid three">
              <label className="span-3">
                Saved Bank Contact
                <SearchableSelect
                  disabled={blockedByExpenseApproval || !bankContacts.length}
                  name="saved_bank_contact_id"
                  onValueChange={selectBankContact}
                  options={bankContacts.map((contact) => ({ value: contact.id, label: contact.account_holder_name, helper: [contact.bank_account_no, contact.ifsc, contact.contact_no, contact.email].filter(Boolean).join(" · ") }))}
                  placeholder={bankContacts.length ? "Search your saved bank contacts" : "No saved bank contacts"}
                />
              </label>
              <label>
                Bank Account No *
                <input className="field" disabled={blockedByExpenseApproval} name="bank_account_no" onChange={(event) => { setBankAccountNo(event.target.value.toUpperCase()); invalidateBankVerification(); }} required value={bankAccountNo} />
              </label>
              <label>
                IFSC *
                <span className="field-with-action">
                  <input className="field" disabled={blockedByExpenseApproval} name="ifsc" onChange={(event) => { setIfsc(event.target.value.toUpperCase()); invalidateBankVerification(); }} required value={ifsc} />
                  <button className="button secondary compact" disabled={blockedByExpenseApproval || bankVerifying || !bankAccountNo || !ifsc} onClick={verifyBankAccount} type="button">{bankVerifying ? "Verifying..." : bankVerified ? "Verified" : "Verify"}</button>
                </span>
                {bankVerificationMessage ? <span className={bankVerified ? "verification-message success" : "verification-message error"}>{bankVerificationMessage}</span> : null}
              </label>
              <label>
                Acc Holder Name *
                <input className="field" name="account_holder_name" readOnly required value={accountHolderName} />
                <input name="bank_verified" type="hidden" value={bankVerified ? "1" : "0"} />
              </label>
              <label>
                Contact No
                <input className="field" disabled={blockedByExpenseApproval} name="contact_no" onChange={(event) => setContactNo(event.target.value)} placeholder="Optional" type="tel" value={contactNo} />
              </label>
              <label>
                Email
                <input className="field" disabled={blockedByExpenseApproval} name="email" onChange={(event) => setContactEmail(event.target.value)} placeholder="Optional" type="email" value={contactEmail} />
              </label>
            </div>
          )}
        </>
      ) : null}

      {selectedHead?.payment_head_questions.length ? (
        <>
          <div className="section-divider" />
          <div className="form-grid three">
            {selectedHead.payment_head_questions.map((question) => {
              const questionLabel = question.question_text.toLowerCase();
              const isWideField = question.answer_type === "textarea" || questionLabel.includes("mail subject") || questionLabel.includes("subject");
              return (
                <label key={question.id} className={isWideField ? "span-3" : undefined}>
                  {question.question_text}{question.is_required ? " *" : ""}
                  <input type="hidden" name="question_ids" value={question.id} />
                  {inputForQuestion(question, blockedByExpenseApproval)}
                </label>
              );
            })}
          </div>
        </>
      ) : null}

      <div className="section-divider" />
      <div className="form-grid two">
        <label className="span-2">
          Remarks
          <textarea className="field" disabled={blockedByExpenseApproval} name="remarks" rows={3} />
        </label>
      </div>

      <div className="form-actions">
        <SubmitButton
          disabled={!heads.length || !locationOptions.length || blockedByExpenseApproval}
          disabledText={blockedByExpenseApproval ? "Required Expense Approval" : !heads.length ? "Add payment head first" : "Add location first"}
        >
          {submitLabel}
        </SubmitButton>
      </div>
    </form>
  );
}
