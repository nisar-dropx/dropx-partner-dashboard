/**
 * Payment heads whose approval chain lives in People / DropX One.
 * Finance only processes the resulting payment_request (already APPROVED).
 * Payment Approval Steps are not used for these heads.
 */
const PEOPLE_APPROVED_PAYMENT_HEAD_CODES = new Set([
  "SALARY_ADVANCE",
  "PAY_ADVANCE",
  "ADVANCE",
  "EMPLOYEE_REIMBURSEMENT"
]);

export function isPeopleApprovedPaymentHead(code: string | null | undefined) {
  return PEOPLE_APPROVED_PAYMENT_HEAD_CODES.has(String(code ?? "").trim().toUpperCase());
}

export function peopleApprovedPaymentHeadMessage(code: string | null | undefined) {
  const upper = String(code ?? "").trim().toUpperCase();
  if (upper === "EMPLOYEE_REIMBURSEMENT") {
    return "Employee reimbursements are approved in People / DropX One (manager → Finance). When Finance releases a claim, Payments receives an already-approved request for processing only. Payment Approval Steps are not used.";
  }
  if (["SALARY_ADVANCE", "PAY_ADVANCE", "ADVANCE"].includes(upper)) {
    return "Salary advances are approved in People / DropX One (operational manager → Finance). When Finance approves, a payment request is created under this head already approved and waiting for payment processing. Payment Approval Steps are not used.";
  }
  return "This payment head is approved in People before it reaches Payments. Payment Approval Steps are not used.";
}
