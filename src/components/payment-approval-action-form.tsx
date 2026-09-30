"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";

type PaymentApprovalActionFormProps = {
  requestId: string;
  requestNo: string;
  requestRemarks?: string | null;
  status: string;
  currentStep?: number | null;
  totalSteps?: number | null;
  approveAction: (formData: FormData) => void | Promise<void>;
  returnAction: (formData: FormData) => void | Promise<void>;
  rejectAction: (formData: FormData) => void | Promise<void>;
};

function PaymentApprovalButton({
  actionName,
  children,
  className,
  formAction,
  onBeforeSubmit,
  pendingAction
}: {
  actionName: string;
  children: string;
  className: string;
  formAction: (formData: FormData) => void | Promise<void>;
  onBeforeSubmit: () => boolean;
  pendingAction: string | null;
}) {
  const { pending } = useFormStatus();
  const isPending = pending && pendingAction === actionName;

  return (
    <button
      className={`${className} ${isPending ? "loading" : ""}`}
      disabled={pending}
      formAction={formAction}
      onClick={(event) => {
        if (!onBeforeSubmit()) event.preventDefault();
      }}
      type="submit"
    >
      {isPending ? <span className="button-spinner" aria-hidden="true" /> : null}
      <span>{isPending ? "Working" : children}</span>
    </button>
  );
}

export function PaymentApprovalActionForm({
  requestId,
  requestNo,
  requestRemarks,
  status,
  currentStep,
  totalSteps,
  approveAction,
  returnAction,
  rejectAction
}: PaymentApprovalActionFormProps) {
  const remarksRef = useRef<HTMLTextAreaElement>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const displayedCurrentStep = Number(currentStep) || 0;
  const displayedTotalSteps = Math.max(Number(totalSteps) || 0, displayedCurrentStep);
  const isFinalApprovalStep = displayedCurrentStep > 0 && displayedTotalSteps > 0 && displayedCurrentStep >= displayedTotalSteps;

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
    if (!valid) return false;

    const confirmation = actionName === "approve"
      ? `Approve ${requestNo}? This moves the request to the next configured step.`
      : actionName === "reject"
        ? `Reject ${requestNo}? The requester will be notified of this final decision.`
        : null;
    if (confirmation && !window.confirm(confirmation)) return false;
    setPendingAction(actionName);
    return valid;
  }

  return (
    <form className="payment-approval-action-form">
      <input name="request_id" type="hidden" value={requestId} />
      <input name="status" type="hidden" value={status} />
      <div className="payment-approval-decision-intro">
        <div>
          <strong>Decision required</strong>
          <span>{displayedCurrentStep && displayedTotalSteps
            ? `${isFinalApprovalStep ? "Final approval" : "Approval"} step ${displayedCurrentStep} of ${displayedTotalSteps}`
            : "Review the request and supporting evidence before deciding."}</span>
        </div>
        <span className="status-pill warn">Awaiting your action</span>
      </div>
      {requestRemarks?.trim() ? <p className="payment-requestor-remarks"><strong>Requester note:</strong> {requestRemarks}</p> : null}
      <label>
        Decision note
        <textarea className="field" name="comments" ref={remarksRef} rows={2} />
        <small>Optional when approving. Required when returning or rejecting.</small>
      </label>
      <div className="payment-approval-action-buttons">
        <PaymentApprovalButton
          actionName="approve"
          className="button payment-approve-button"
          formAction={approveAction}
          onBeforeSubmit={() => validateAction("approve")}
          pendingAction={pendingAction}
        >
          {isFinalApprovalStep ? "Approve final" : "Approve & continue"}
        </PaymentApprovalButton>
        <PaymentApprovalButton
          actionName="return"
          className="button payment-return-button"
          formAction={returnAction}
          onBeforeSubmit={() => validateAction("return")}
          pendingAction={pendingAction}
        >
          Return for correction
        </PaymentApprovalButton>
        <PaymentApprovalButton
          actionName="reject"
          className="button payment-reject-button"
          formAction={rejectAction}
          onBeforeSubmit={() => validateAction("reject")}
          pendingAction={pendingAction}
        >
          Reject request
        </PaymentApprovalButton>
      </div>
    </form>
  );
}
