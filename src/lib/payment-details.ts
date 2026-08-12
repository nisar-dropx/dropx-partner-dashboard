import type { PaymentMode } from "@/lib/payment-modes";

export type SubmittedPaymentDetails = {
  account_holder_name?: string | null;
  amount?: number | string | null;
  bank_account_no?: string | null;
  ifsc?: string | null;
  payment_mode?: PaymentMode | string | null;
  payment_portal?: string | null;
  payment_reference?: string | null;
};

function present(value: unknown) {
  return String(value ?? "").trim().length > 0;
}

export function hasSubmittedPaymentDetails(request: SubmittedPaymentDetails) {
  if (request.amount == null || !present(request.payment_mode)) return false;
  if (request.payment_mode === "account_transfer") {
    return present(request.bank_account_no) && present(request.ifsc) && present(request.account_holder_name);
  }
  if (request.payment_mode === "upi_payment") {
    return present(request.payment_reference) && present(request.account_holder_name);
  }
  if (request.payment_mode === "online_payment") {
    return present(request.payment_portal);
  }
  return false;
}
