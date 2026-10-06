import type { AdditionalPaymentCalculationType } from "./workforce-additional-payments.ts";

export type WorkforceAdditionalPaymentField = {
  id: string;
  code: string;
  name: string;
  calculation_type: AdditionalPaymentCalculationType;
  default_rate_value: number | null;
  is_active: boolean;
};

export type WorkforceAdditionalPaymentValue = {
  id: string;
  additional_payment_field_id: string;
  workforce_id: string;
  station_id?: string | null;
  field_code_snapshot: string;
  field_name_snapshot: string;
  calculation_type_snapshot: AdditionalPaymentCalculationType;
  input_value: number;
  rate_value: number | null;
  final_amount: number;
};

export type WorkforceAdditionalPaymentLine = {
  fieldId: string;
  code: string;
  label: string;
  calculationType: AdditionalPaymentCalculationType;
  inputValue: number;
  rateValue: number | null;
  amount: number;
};

function rounded(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function workforceAdditionalPaymentLines(
  _baseAmount: number,
  fields: WorkforceAdditionalPaymentField[],
  values: WorkforceAdditionalPaymentValue[]
): WorkforceAdditionalPaymentLine[] {
  const valueByField = new Map(values.map((value) => [value.additional_payment_field_id, value]));
  const configured = fields.flatMap<WorkforceAdditionalPaymentLine>((field) => {
    const value = valueByField.get(field.id);
    if (!value) return [];
    return [{
      fieldId: field.id,
      code: value.field_code_snapshot || field.code,
      label: value.field_name_snapshot || field.name,
      calculationType: value.calculation_type_snapshot || field.calculation_type,
      inputValue: Number(value.input_value),
      rateValue: value.rate_value === null ? null : Number(value.rate_value),
      amount: rounded(Number(value.final_amount))
    }];
  });
  const known = new Set(fields.map((field) => field.id));
  const historical = values.filter((value) => !known.has(value.additional_payment_field_id)).map((value) => ({
    fieldId: value.additional_payment_field_id,
    code: value.field_code_snapshot,
    label: value.field_name_snapshot,
    calculationType: value.calculation_type_snapshot,
    inputValue: Number(value.input_value),
    rateValue: value.rate_value === null ? null : Number(value.rate_value),
    amount: rounded(Number(value.final_amount))
  }));
  return [...configured, ...historical];
}

export function workforceAdditionalPaymentTotal(lines: WorkforceAdditionalPaymentLine[]) {
  return rounded(lines.reduce((sum, line) => sum + line.amount, 0));
}
