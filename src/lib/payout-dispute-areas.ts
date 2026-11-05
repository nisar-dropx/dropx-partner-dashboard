/** Shared by DropX One submission and the payout approval desk. */
export const PAYOUT_DISPUTE_AREAS = [
  { value: "work_days", label: "Work Days", legacyCategory: "training" },
  { value: "attendance_pay", label: "Attendance Pay", legacyCategory: "training" },
  { value: "delivery", label: "Delivery", legacyCategory: "counts" },
  { value: "customer_return", label: "Customer Return", legacyCategory: "counts" },
  { value: "pickup", label: "Pickup", legacyCategory: "counts" },
  { value: "mfn_seller_pickup", label: "MFN / Seller Pickup", legacyCategory: "counts" },
  { value: "allowances", label: "Allowances", legacyCategory: "other" },
  { value: "incentive", label: "Incentive", legacyCategory: "other" },
  { value: "deduction", label: "Deduction", legacyCategory: "loss" },
  { value: "other", label: "Others", legacyCategory: "other" },
] as const;

export type PayoutDisputeArea = (typeof PAYOUT_DISPUTE_AREAS)[number]["value"];
