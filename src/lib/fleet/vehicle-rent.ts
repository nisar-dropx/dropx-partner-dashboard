export function parseVehicleRent(input: Record<string, unknown>): { values: Record<string, string | null>; error?: string } {
  if (!("rent_amount" in input) && !("rent_period" in input)) return { values: {} };
  if (!("rent_amount" in input)) return { values: {}, error: "Enter the rent amount with its billing period." };
  const amount = String(input.rent_amount ?? "").trim();
  if (!amount) return { values: { rent_amount: null, rent_period: null } };
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(amount) || Number(amount) > 9999999999.99) return { values: {}, error: "Enter a valid rent amount of zero or more, with up to two decimal places." };
  if (input.rent_period !== "monthly" && input.rent_period !== "daily") return { values: {}, error: "Choose Per month or Per day for rent." };
  return { values: { rent_amount: Number(amount).toFixed(2), rent_period: input.rent_period } };
}
