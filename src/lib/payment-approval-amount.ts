type PaymentApprovalAmountFields = {
  amount: number | string | null;
  amount_requested: number | string | null;
};

/** Display only: never promote an estimate into the actual payment amount. */
export function paymentApprovalAmount(request: PaymentApprovalAmountFields) {
  const value = request.amount ?? request.amount_requested;
  return {
    text: value == null ? "-" : `Rs ${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`,
    isEstimated: request.amount == null && request.amount_requested != null
  };
}
