type BankPayment = {
  amount?: number | null;
  amount_requested?: number | null;
  bank_paid_amount?: number | null;
  status?: string | null;
  approval_status?: string | null;
};

/** Keep the approved amount intact; bank files carry only its unpaid balance. */
export function paymentBankBalance(payment: BankPayment) {
  const approvedPaise = Math.max(0, Math.round(Number(payment.amount ?? payment.amount_requested ?? 0) * 100));
  const legacyPaid = String(payment.status ?? "").toLowerCase() === "processed"
    || String(payment.approval_status ?? "").toUpperCase() === "PROCESSED";
  const paidPaise = payment.bank_paid_amount == null
    ? legacyPaid ? approvedPaise : 0
    : Math.max(0, Math.round(Number(payment.bank_paid_amount) * 100));
  const remainingPaise = Math.max(0, approvedPaise - paidPaise);
  return {
    approved: approvedPaise / 100,
    paid: paidPaise / 100,
    remaining: remainingPaise / 100,
    partial: paidPaise > 0 && remainingPaise > 0
  };
}
