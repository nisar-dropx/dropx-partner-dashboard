export type DirectPaymentComponent = {
  code: string;
  label: string;
  type: "amount" | "production";
  schedule?: "per_hour" | "per_day" | "per_month" | null;
  active?: boolean;
  sortOrder?: number;
};

export type DirectPaymentMethod = {
  id: string;
  code: string;
  name: string;
  components: DirectPaymentComponent[];
};

function activeComponents(components: DirectPaymentComponent[]) {
  return components.filter((component) => component.active !== false);
}

export function directPaymentMethodIssue(components: DirectPaymentComponent[]) {
  const active = activeComponents(components);
  if (active.some((component) => component.type === "production")) {
    return "Direct payment methods cannot contain production components.";
  }
  if (!active.some((component) => component.type === "amount")) {
    return "Direct payment methods need at least one active amount component.";
  }
  if (active.some((component) => component.type === "amount" && !["per_hour", "per_day", "per_month"].includes(String(component.schedule ?? "")))) {
    return "Every direct payment amount needs a per-hour, per-day or per-month schedule.";
  }
  return null;
}

export function directPaymentMethodEligible(components: DirectPaymentComponent[]) {
  return directPaymentMethodIssue(components) === null;
}

export function normalizeDirectPaymentValues(
  components: DirectPaymentComponent[],
  supplied: unknown
) {
  const issue = directPaymentMethodIssue(components);
  if (issue) throw new Error(issue);
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    throw new Error("Payment values are invalid. Refresh the page and try again.");
  }

  const input = supplied as Record<string, unknown>;
  const expected = activeComponents(components).filter((component) => component.type === "amount");
  const allowedCodes = new Set(expected.map((component) => component.code));
  const unexpected = Object.keys(input).find((code) => !allowedCodes.has(code));
  if (unexpected) throw new Error("Payment values contain a field that is not part of the selected payment method.");

  return Object.fromEntries(expected.map((component) => {
    const raw = typeof input[component.code] === "string"
      ? String(input[component.code]).replace(/,/g, "").trim()
      : input[component.code];
    if (raw === "" || raw === null || raw === undefined) {
      throw new Error(`${component.label} is required.`);
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${component.label} must be a valid non-negative number.`);
    }
    return [component.code, value];
  }));
}

export function previousIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Effective date is invalid.");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Effective date is invalid.");
  }
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
