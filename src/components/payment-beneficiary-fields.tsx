"use client";

import { useEffect, useMemo, useState } from "react";
import { PAYMENT_MODES, normalizePaymentModes, type PaymentMode } from "@/lib/payment-modes";

type PaymentBeneficiaryFieldsProps = {
  allowedPaymentModes?: PaymentMode[] | null;
  defaultBankAccountNo?: string | null;
  defaultContactNo?: string | null;
  defaultEmail?: string | null;
  defaultIfsc?: string | null;
};

export function PaymentBeneficiaryFields({
  allowedPaymentModes,
  defaultBankAccountNo,
  defaultContactNo,
  defaultEmail,
  defaultIfsc
}: PaymentBeneficiaryFieldsProps) {
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("account_transfer");
  const [bankAccountNo, setBankAccountNo] = useState((defaultBankAccountNo ?? "").toUpperCase());
  const [ifsc, setIfsc] = useState((defaultIfsc ?? "").toUpperCase());
  const [upiId, setUpiId] = useState("");
  const [accountHolderName, setAccountHolderName] = useState("");
  const [contactNo, setContactNo] = useState(defaultContactNo ?? "");
  const [contactEmail, setContactEmail] = useState(defaultEmail ?? "");
  const [bankVerified, setBankVerified] = useState(false);
  const [bankVerifying, setBankVerifying] = useState(false);
  const [upiVerified, setUpiVerified] = useState(false);
  const [upiVerifying, setUpiVerifying] = useState(false);
  const [upiAccountHolderName, setUpiAccountHolderName] = useState("");
  const [verificationMessage, setVerificationMessage] = useState("");
  const supportedPaymentModes = useMemo(() => normalizePaymentModes(allowedPaymentModes), [allowedPaymentModes]);

  useEffect(() => {
    const firstSupportedMode = supportedPaymentModes[0];
    if (firstSupportedMode && !supportedPaymentModes.includes(paymentMode)) setPaymentMode(firstSupportedMode);
  }, [paymentMode, supportedPaymentModes]);

  function invalidateBankVerification() {
    setBankVerified(false);
    setAccountHolderName("");
    setVerificationMessage("");
  }

  async function verifyBankAccount() {
    setBankVerifying(true);
    setVerificationMessage("");
    try {
      const response = await fetch("/api/payments/bank-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankAccountNo, ifsc, contactNo, email: contactEmail })
      });
      const result = await response.json();
      if (!response.ok || !result.verified) {
        throw new Error(result.error || result.message || "Bank verification failed.");
      }
      setAccountHolderName(result.accountHolderName || "");
      setBankVerified(true);
      setVerificationMessage(result.source === "contact" ? "Verified account found in Contacts." : "Bank account verified.");
    } catch (error) {
      setBankVerified(false);
      setAccountHolderName("");
      setVerificationMessage(error instanceof Error ? error.message : "Bank verification failed.");
    } finally {
      setBankVerifying(false);
    }
  }

  async function verifyUpiId() {
    setUpiVerifying(true);
    setVerificationMessage("");
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
      setVerificationMessage(result.source === "contact" ? "Verified UPI ID found in Contacts." : "UPI ID verified.");
    } catch (error) {
      setUpiVerified(false);
      setUpiAccountHolderName("");
      setVerificationMessage(error instanceof Error ? error.message : "UPI verification failed.");
    } finally {
      setUpiVerifying(false);
    }
  }

  return (
    <>
      <div className="payment-mode-switch" role="radiogroup" aria-label="Payment method">
        {PAYMENT_MODES.filter((option) => supportedPaymentModes.includes(option.value)).map((option) => (
          <label key={option.value} className={paymentMode === option.value ? "active" : undefined}>
            <input
              checked={paymentMode === option.value}
              name="payment_mode"
              onChange={() => setPaymentMode(option.value)}
              type="radio"
              value={option.value}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>

      {paymentMode === "online_payment" ? (
        <div className="form-grid three" key="online-payment-fields">
          <label>
            Payment Portal *
            <input className="field" name="payment_portal" required placeholder="Portal or service name" />
          </label>
          <label>
            Reference ID / Service Number / Consumer ID
            <input className="field" name="payment_reference" placeholder="Optional" />
          </label>
          <label>
            Contact No
            <input className="field" name="contact_no" onChange={(event) => setContactNo(event.target.value)} placeholder="Optional" type="tel" value={contactNo} />
          </label>
          <label>
            Email
            <input className="field" name="email" onChange={(event) => setContactEmail(event.target.value)} placeholder="Optional" type="email" value={contactEmail} />
          </label>
        </div>
      ) : paymentMode === "upi_payment" ? (
        <div className="form-grid three" key="upi-payment-fields">
          <label>
            UPI ID *
            <span className="field-with-action">
              <input
                autoComplete="off"
                className="field"
                name="upi_id"
                onChange={(event) => {
                  setUpiId(event.target.value.replace(/\s/g, "").toLowerCase());
                  setUpiVerified(false);
                  setUpiAccountHolderName("");
                  setVerificationMessage("");
                }}
                placeholder="name@bank"
                required
                value={upiId}
              />
              <button className="button secondary compact" disabled={upiVerifying || !upiId || upiVerified} onClick={verifyUpiId} type="button">
                {upiVerifying ? "Verifying..." : upiVerified ? "Verified" : "Verify"}
              </button>
            </span>
            {verificationMessage ? <span className={upiVerified ? "verification-message success" : "verification-message error"}>{verificationMessage}</span> : null}
          </label>
          <label>
            Account Holder Name *
            <input className="field" name="upi_account_holder_name" readOnly required value={upiAccountHolderName} />
            <input name="upi_verified" type="hidden" value={upiVerified ? "1" : "0"} />
          </label>
          <label>
            Contact No
            <input className="field" name="contact_no" onChange={(event) => setContactNo(event.target.value)} placeholder="Optional" type="tel" value={contactNo} />
          </label>
          <label>
            Email
            <input className="field" name="email" onChange={(event) => setContactEmail(event.target.value)} placeholder="Optional" type="email" value={contactEmail} />
          </label>
        </div>
      ) : (
        <div className="form-grid three" key="account-transfer-fields">
          <label>
            Bank Account No *
            <input
              className="field"
              maxLength={30}
              minLength={4}
              name="bank_account_no"
              onChange={(event) => {
                setBankAccountNo(event.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase());
                invalidateBankVerification();
              }}
              required
              value={bankAccountNo}
            />
          </label>
          <label>
            IFSC *
            <span className="field-with-action">
              <input
                className="field"
                maxLength={11}
                minLength={11}
                name="ifsc"
                onChange={(event) => {
                  setIfsc(event.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase());
                  invalidateBankVerification();
                }}
                required
                value={ifsc}
              />
              <button
                className="button secondary compact"
                disabled={bankVerifying || !bankAccountNo || ifsc.length !== 11 || bankVerified}
                onClick={verifyBankAccount}
                type="button"
              >
                {bankVerifying ? "Verifying..." : bankVerified ? "Verified" : "Verify"}
              </button>
            </span>
            {verificationMessage ? (
              <span className={bankVerified ? "verification-message success" : "verification-message error"}>{verificationMessage}</span>
            ) : null}
          </label>
          <label>
            Acc Holder Name *
            <input className="field" name="account_holder_name" readOnly required value={accountHolderName} />
            <input name="bank_verified" type="hidden" value={bankVerified ? "1" : "0"} />
          </label>
          <label>
            Contact No
            <input className="field" name="contact_no" onChange={(event) => setContactNo(event.target.value)} placeholder="Optional" type="tel" value={contactNo} />
          </label>
          <label>
            Email
            <input className="field" name="email" onChange={(event) => setContactEmail(event.target.value)} placeholder="Optional" type="email" value={contactEmail} />
          </label>
        </div>
      )}
    </>
  );
}
