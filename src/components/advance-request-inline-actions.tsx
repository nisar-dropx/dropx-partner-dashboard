"use client";

import { useState } from "react";
import { approveAdvanceRequest, rejectAdvanceRequest } from "@/app/payments/advance-request/actions";

export function AdvanceRequestInlineActions({
  requestId,
  requestedAmount,
  requesterLabel
}: {
  requestId: string;
  requestedAmount: number;
  requesterLabel: string;
}) {
  const [approvedAmount, setApprovedAmount] = useState("");
  const [useRequestedAmount, setUseRequestedAmount] = useState(false);

  return (
    <form className="advance-request-inline-form">
      <input name="requestId" type="hidden" value={requestId} />
      <div className="advance-request-amount-control">
        <input
          aria-label={`Approved amount for ${requesterLabel}`}
          className="field"
          min="0.01"
          name="approvedAmount"
          onChange={(event) => {
            setApprovedAmount(event.target.value);
            setUseRequestedAmount(Number(event.target.value) === requestedAmount);
          }}
          placeholder="Approved amt"
          step="0.01"
          type="number"
          value={approvedAmount}
        />
        <label className="advance-request-full-amount">
          <input
            checked={useRequestedAmount}
            onChange={(event) => {
              setUseRequestedAmount(event.target.checked);
              setApprovedAmount(event.target.checked ? String(requestedAmount) : "");
            }}
            type="checkbox"
          />
          Use requested amount
        </label>
      </div>
      <input aria-label={`Remarks for ${requesterLabel}`} className="field" maxLength={500} name="comment" placeholder="Remarks (required to reject)" />
      <div className="advance-request-inline-actions">
        <button className="button compact payment-approve-button" formAction={approveAdvanceRequest}>Approve</button>
        <button className="button compact payment-reject-button" formAction={rejectAdvanceRequest}>Reject</button>
      </div>
    </form>
  );
}
