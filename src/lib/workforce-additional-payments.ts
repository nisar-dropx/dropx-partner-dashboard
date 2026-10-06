export const additionalPaymentCalculationTypes = [
  "manual_amount",
  "units_x_rate"
] as const;

export type AdditionalPaymentCalculationType = typeof additionalPaymentCalculationTypes[number];

export type AdditionalPaymentFieldDefinition = {
  code: string;
  name: string;
  calculationType: AdditionalPaymentCalculationType;
  defaultRateValue?: number | string | null;
};

export type AdditionalPaymentCalculation = {
  code: string;
  name: string;
  calculationType: AdditionalPaymentCalculationType;
  inputValue: number;
  rateValue: number | null;
  finalAmount: number;
};

function parseNonNegativeNumber(value: number | string, label: string) {
  const normalized = typeof value === "string" ? value.replace(/,/g, "").trim() : value;
  if (normalized === "") throw new Error(`${label} is required.`);
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number.`);
  if (parsed < 0) throw new Error(`${label} must be non-negative.`);
  return parsed;
}

function optionalNonNegativeNumber(value: number | string | null | undefined, label: string) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  return parseNonNegativeNumber(value, label);
}

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function normalizeAdditionalPaymentCode(value: unknown) {
  const code = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(code)) {
    throw new Error("Code must start with a letter and contain only letters, numbers, underscores or hyphens.");
  }
  return code;
}

export function isAdditionalPaymentCalculationType(value: unknown): value is AdditionalPaymentCalculationType {
  return additionalPaymentCalculationTypes.includes(value as AdditionalPaymentCalculationType);
}

export function calculateAdditionalPayment(
  field: AdditionalPaymentFieldDefinition,
  inputValue: number | string,
  rateValue?: number | string | null
): AdditionalPaymentCalculation {
  const code = normalizeAdditionalPaymentCode(field.code);
  const name = String(field.name ?? "").trim();
  if (!name) throw new Error("Additional payment field name is required.");
  if (!isAdditionalPaymentCalculationType(field.calculationType)) {
    throw new Error("Unsupported additional payment calculation type.");
  }

  const input = parseNonNegativeNumber(inputValue, "Input value");
  if (field.calculationType === "manual_amount") {
    return {
      code,
      name,
      calculationType: field.calculationType,
      inputValue: input,
      rateValue: null,
      finalAmount: roundCurrency(input)
    };
  }

  const resolvedRate = optionalNonNegativeNumber(
    rateValue === null || rateValue === undefined || (typeof rateValue === "string" && rateValue.trim() === "")
      ? field.defaultRateValue
      : rateValue,
    "Rate"
  );
  if (resolvedRate === null) {
    throw new Error("Rate is required.");
  }

  return {
    code,
    name,
    calculationType: field.calculationType,
    inputValue: input,
    rateValue: resolvedRate,
    finalAmount: roundCurrency(input * resolvedRate)
  };
}

export function validateAdditionalPaymentPeriod(effectiveFrom: string, effectiveTo: string) {
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDate.test(effectiveFrom) || !isoDate.test(effectiveTo)) {
    throw new Error("Additional payment period dates must use YYYY-MM-DD format.");
  }
  const fromTime = Date.parse(`${effectiveFrom}T00:00:00Z`);
  const toTime = Date.parse(`${effectiveTo}T00:00:00Z`);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) {
    throw new Error("Additional payment period contains an invalid date.");
  }
  if (
    new Date(fromTime).toISOString().slice(0, 10) !== effectiveFrom
    || new Date(toTime).toISOString().slice(0, 10) !== effectiveTo
  ) {
    throw new Error("Additional payment period contains an invalid date.");
  }
  if (effectiveTo < effectiveFrom) {
    throw new Error("Effective to date cannot be before effective from date.");
  }
  return { effectiveFrom, effectiveTo };
}
