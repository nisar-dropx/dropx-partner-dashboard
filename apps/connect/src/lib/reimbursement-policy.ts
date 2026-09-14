export type ExpensePolicyQuote = {
  id: string; head_name: string; claimed_amount: number; limit_amount: number | null;
  limit_basis: "per_day" | "per_item" | null; already_used: number; permissible_amount: number | null;
  excess_amount: number; eligible_amount: number; excess_action: "cap" | "special_approval" | null;
  special_approver_user_id: string | null; rule_id: string | null;
};
const money = (value: number) => `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
export function expensePolicyMessage(quote: ExpensePolicyQuote) {
  if (quote.limit_amount == null) return "Designation limit not configured in Finance. Subject to the existing approval policy.";
  const limit = `Limit ${money(quote.limit_amount)} ${quote.limit_basis === "per_day" ? "per day / night" : "per expense item"}`;
  const used = quote.already_used > 0 ? ` · ${money(quote.already_used)} already used or reserved` : "";
  if (quote.excess_amount <= 0) return `${limit}${used} · Within limit`;
  return `${limit}${used} · Exceeds by ${money(quote.excess_amount)}. ${quote.excess_action === "cap" ? `Maximum payable ${money(quote.eligible_amount)}.` : "Special approval required for the excess."}`;
}
