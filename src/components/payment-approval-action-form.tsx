"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";

export type PaymentActionResult = {
  action: "approve" | "return" | "reject";
  message: string;
  status: string;
  statusLabel: string;
};

type PaymentApprovalActionFormProps = {
  requestId: string;
  requestRemarks?: string | null;
  status: string;
  approveAction: (formData: FormData) => void | Promise<void>;
  returnAction: (formData: FormData) => void | Promise<void>;
  rejectAction: (formData: FormData) => void | Promise<void>;
  endpoint?: string;
  onComplete?: (result: PaymentActionResult) => void;
};

function ServerActionButton({ actionName, children, className, formAction, onBeforeSubmit, pendingAction }: {
  actionName: string;
  children: string;
  className: string;
  formAction: (formData: FormData) => void | Promise<void>;
  onBeforeSubmit: () => boolean;
  pendingAction: string | null;
}) {
  const { pending } = useFormStatus();
  const isPending = pending && pendingAction === actionName;
  return <button className={`${className} ${isPending ? "loading" : ""}`} disabled={pending} formAction={formAction} onClick={(event) => { if (!onBeforeSubmit()) event.preventDefault(); }} type="submit">
    {isPending ? <span className="button-spinner" aria-hidden="true" /> : null}<span>{isPending ? "Working" : children}</span>
  </button>;
}

export function PaymentApprovalActionForm({ requestId, requestRemarks, status, approveAction, returnAction, rejectAction, endpoint, onComplete }: PaymentApprovalActionFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const remarksRef = useRef<HTMLTextAreaElement>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState("");

  function validateAction(actionName: string) {
    const remarks = remarksRef.current;
    if (!remarks) return true;
    const needsRemarks = actionName === "return" || actionName === "reject";
    remarks.required = needsRemarks;
    remarks.setCustomValidity("");
    if (needsRemarks && !remarks.value.trim()) remarks.setCustomValidity(actionName === "return" ? "Return remarks is required." : "Reject remarks is required.");
    const valid = remarks.reportValidity();
    if (valid) setPendingAction(actionName);
    return valid;
  }

  async function runInline(action: PaymentActionResult["action"]) {
    if (!endpoint || !formRef.current || !validateAction(action)) return;
    setError("");
    try {
      const form = new FormData(formRef.current);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, requestId, status, comments: String(form.get("comments") ?? "") })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "The payment request could not be updated.");
      if (remarksRef.current) remarksRef.current.value = "";
      onComplete?.(payload as PaymentActionResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The payment request could not be updated.");
    } finally {
      setPendingAction(null);
    }
  }

  const inlineButton = (action: PaymentActionResult["action"], label: string, className: string) => <button className={`${className} ${pendingAction === action ? "loading" : ""}`} disabled={Boolean(pendingAction)} onClick={() => runInline(action)} type="button">
    {pendingAction === action ? <span className="button-spinner" aria-hidden="true" /> : null}<span>{pendingAction === action ? "Working" : label}</span>
  </button>;

  return <form className="payment-approval-action-form" ref={formRef}>
    <input name="request_id" type="hidden" value={requestId} /><input name="status" type="hidden" value={status} />
    {requestRemarks?.trim() ? <p className="payment-requestor-remarks"><strong>Remark:</strong> {requestRemarks}</p> : null}
    <label>Remarks<textarea className="field" name="comments" ref={remarksRef} rows={2} /></label>
    {error ? <p className="payment-action-error" role="alert">{error}</p> : null}
    <div className="payment-approval-action-buttons">
      {endpoint ? <>
        {inlineButton("approve", "Approve", "button payment-approve-button")}
        {inlineButton("return", "Return", "button payment-return-button")}
        {inlineButton("reject", "Reject", "button payment-reject-button")}
      </> : <>
        <ServerActionButton actionName="approve" className="button payment-approve-button" formAction={approveAction} onBeforeSubmit={() => validateAction("approve")} pendingAction={pendingAction}>Approve</ServerActionButton>
        <ServerActionButton actionName="return" className="button payment-return-button" formAction={returnAction} onBeforeSubmit={() => validateAction("return")} pendingAction={pendingAction}>Return</ServerActionButton>
        <ServerActionButton actionName="reject" className="button payment-reject-button" formAction={rejectAction} onBeforeSubmit={() => validateAction("reject")} pendingAction={pendingAction}>Reject</ServerActionButton>
      </>}
    </div>
  </form>;
}
