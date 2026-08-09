"use client";

import { useRef } from "react";
import { SubmitButton } from "@/components/submit-button";

type PaymentApprovalActionFormProps = {
  requestId: string;
  requestRemarks?: string | null;
  status: string;
  approveAction: (formData: FormData) => void | Promise<void>;
  returnAction: (formData: FormData) => void | Promise<void>;
  rejectAction: (formData: FormData) => void | Promise<void>;
};

function PaymentApprovalButton({
  actionName,
  children,
  className,
  formAction,
  onBeforeSubmit
}: {
  actionName: string;
  children: string;
  className: string;
  formAction: (formData: FormData) => void | Promise<void>;
  onBeforeSubmit: () => boolean;
}) {
  return (
    <SubmitButton
      className={className}
      confirmDescription="This action updates the request immediately."
      confirmMessage={`Are you sure you want to ${actionName} this request?`}
      confirmSubmitText={children}
      confirmTitle={`${children} request?`}
      formAction={formAction}
      onBeforeConfirm={onBeforeSubmit}
      pendingText="Working"
    >
      {children}
    </SubmitButton>
  );
}

export function PaymentApprovalActionForm({
  requestId,
  requestRemarks,
  status,
  approveAction,
  returnAction,
  rejectAction
}: PaymentApprovalActionFormProps) {
  const remarksRef = useRef<HTMLTextAreaElement>(null);
  function validateAction(actionName: string) {
    const remarks = remarksRef.current;
    if (!remarks) return true;

    const needsRemarks = actionName === "return" || actionName === "reject";
    remarks.required = needsRemarks;
    remarks.setCustomValidity("");
    if (needsRemarks && !remarks.value.trim()) {
      remarks.setCustomValidity(actionName === "return" ? "Return remarks is required." : "Reject remarks is required.");
    }

    const valid = remarks.reportValidity();
    return valid;
  }

  return (
    <form className="payment-approval-action-form">
      <input name="request_id" type="hidden" value={requestId} />
      <input name="status" type="hidden" value={status} />
      {requestRemarks?.trim() ? (
        <p className="payment-requestor-remarks">
          <strong>Remark:</strong> {requestRemarks}
        </p>
      ) : null}
      <label>
        Remarks
        <textarea className="field" name="comments" ref={remarksRef} rows={2} />
      </label>
      <div className="payment-approval-action-buttons">
        <PaymentApprovalButton
          actionName="approve"
          className="button payment-approve-button"
          formAction={approveAction}
          onBeforeSubmit={() => validateAction("approve")}
        >
          Approve
        </PaymentApprovalButton>
        <PaymentApprovalButton
          actionName="return"
          className="button payment-return-button"
          formAction={returnAction}
          onBeforeSubmit={() => validateAction("return")}
        >
          Return
        </PaymentApprovalButton>
        <PaymentApprovalButton
          actionName="reject"
          className="button payment-reject-button"
          formAction={rejectAction}
          onBeforeSubmit={() => validateAction("reject")}
        >
          Reject
        </PaymentApprovalButton>
      </div>
    </form>
  );
}
