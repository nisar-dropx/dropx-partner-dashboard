import "server-only";

export type PaymentApprovalListItem = {
  id: string;
  requestNo: string;
  locationCode: string | null;
  paymentHeadName: string;
  amount: number | null;
  amountRequested: number | null;
  requesterName: string | null;
  remarks: string | null;
  createdAt: string;
  attachmentCount: number;
};


/** Station payment requests belong to OpsPulse. People reimbursements, leave,
 * advances and roster approvals have their own reportee-scoped services.
 * Keep this empty compatibility result for already-open DropX One clients. */
export async function listConnectPaymentApprovals(_companyId: string, _actorUserIds: string[]): Promise<PaymentApprovalListItem[]> {
  return [];
}

/** Defense in depth for direct or future callers, including stale mobile clients. */
export async function decideConnectPaymentApproval(_companyId: string, _actorUserIds: string[], _requestId: string, _decision: "approved" | "returned" | "rejected", _comments: string): Promise<never> {
  throw new Error("Station payment requests must be reviewed in OpsPulse.");
}
