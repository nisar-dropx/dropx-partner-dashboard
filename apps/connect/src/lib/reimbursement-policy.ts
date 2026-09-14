export type ExpensePolicyQuote = {
  id: string; category_id?: string; head_name: string; claimed_amount: number; limit_amount: number | null;
  limit_basis: "per_day" | "per_item" | "per_km" | "not_allowed" | null; already_used: number; permissible_amount: number | null;
  expense_allowed?: boolean;
  quantity?: number | null; quantity_required?: boolean; policy_note?: string | null;
  excess_amount: number; eligible_amount: number; excess_action: "cap" | "special_approval" | null;
  special_approver_user_id: string | null; rule_id: string | null;
};
const money = (value: number) => `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
export function expensePolicyMessage(quote: ExpensePolicyQuote) {
  if (quote.expense_allowed === false) return "Not eligible for reimbursement under your designation's Finance policy.";
  if (quote.limit_amount == null) return "Designation limit not configured in Finance. Subject to the existing approval policy.";
  const limit = `Limit ${money(quote.limit_amount)} ${quote.limit_basis === "per_day" ? "per day / night" : quote.limit_basis === "per_km" ? `per km${quote.quantity ? ` × ${quote.quantity} km` : ""}` : "per expense item"}`;
  if (quote.quantity_required) return `${limit} · Enter distance in kilometres to calculate the payable amount.`;
  const used = quote.already_used > 0 ? ` · ${money(quote.already_used)} already used or reserved` : "";
  if (quote.excess_amount <= 0) return `${limit}${used} · Within limit`;
  return `${limit}${used} · Exceeds by ${money(quote.excess_amount)}. ${quote.excess_action === "cap" ? `Maximum payable ${money(quote.eligible_amount)}.` : "Special approval required for the excess."}`;
}
