"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import {
  type ProviderCalculationSources,
  type PaymentCalculationSource,
  type PaymentCalculationType
} from "@/lib/payment-calculation";

type PaymentField = {
  id: string;
  code: string;
  field_type: "amount" | "production";
  label: string;
  pay_schedule: "per_hour" | "per_day" | "per_month" | null;
  calculation_type: PaymentCalculationType;
  calculation_source: PaymentCalculationSource | null;
  provider_calculation_sources?: ProviderCalculationSources | null;
  usage_count?: number;
};

type ProviderMetric = { id: string; provider_id: string; provider_name: string; provider_model_id: string | null; provider_model_name: string | null; name: string; source_key: string };
type ProviderModel = { id: string; provider_id: string; provider_name: string; name: string };
type ProviderAllocation = { provider_id: string; provider_model_id: string | null; provider_metric_id: string };

export function PaymentFieldForm({ action, initialField, submitLabel, providerMetrics = [], providerModels = [], selectedAllocations = [] }: { action: (formData: FormData) => Promise<void>; initialField?: PaymentField; submitLabel: string; providerMetrics?: ProviderMetric[]; providerModels?: ProviderModel[]; selectedAllocations?: ProviderAllocation[] }) {
  const [type, setType] = useState<"amount" | "production">(initialField?.field_type ?? "production");

  return (
    <form action={action} className="payment-field-form">
      {initialField ? <input name="field_id" type="hidden" value={initialField.id} /> : null}
      <div className="payment-field-form-section payment-field-identity">
        <span className="payment-field-section-title">Field details</span>
        <label>Field ID<input className="field mono" defaultValue={initialField?.code} name="field_code" readOnly={Boolean(initialField?.usage_count)} required title={initialField?.usage_count ? "Field ID is locked because this field is already used." : undefined} /></label>
        <label>Display name<input className="field" defaultValue={initialField?.label} name="field_label" required /></label>
        <label>Value type<select className="select" name="field_type" onChange={(event) => setType(event.target.value as "amount" | "production")} value={type}><option value="production">Production count x rate</option><option value="amount">Amount</option></select></label>
        {type === "amount" ? <label>Payment frequency<select className="select" defaultValue={initialField?.pay_schedule ?? "per_month"} name="pay_schedule" required><option value="per_hour">Per hour</option><option value="per_day">Per day</option><option value="per_month">Per month</option></select></label> : null}
      </div>

      <div className="payment-field-form-section payment-field-calculation">
        <span className="payment-field-section-title">How payment is calculated</span>
        <input name="calculation_type" type="hidden" value={type === "production" ? "count_x_rate" : "manual_input"} />
        {type === "production" ? <>
          <div className="payment-field-allocation-head"><span>Provider</span><span>Operating model</span><span>Production count</span></div>
          {providerModels.map((model) => {
            const options = providerMetrics.filter((metric) => metric.provider_id === model.provider_id && (metric.provider_model_id === model.id || metric.provider_model_id === null));
            const selected = selectedAllocations.find((allocation) => allocation.provider_id === model.provider_id && allocation.provider_model_id === model.id);
            return <div className="payment-field-allocation-row" key={`${model.provider_id}:${model.id}`}>
              <strong>{model.provider_name}</strong><span>{model.name}</span>
              <select className="select" defaultValue={selected?.provider_metric_id ? `${model.provider_id}|${model.id}|${selected.provider_metric_id}` : ""} name={`provider_metric_${model.provider_id}_${model.id}`}>
                <option value="">Not used</option>
                {options.map((metric) => <option key={metric.id} value={`${model.provider_id}|${model.id}|${metric.id}`}>{metric.name}{metric.provider_model_id === null ? " (provider default)" : ""}</option>)}
              </select>
            </div>;
          })}
          {Array.from(new Map(providerMetrics.filter((metric) => metric.provider_model_id === null).map((metric) => [metric.provider_id, metric]))).map(([providerId, group]) => {
            const options = providerMetrics.filter((metric) => metric.provider_id === providerId && metric.provider_model_id === null);
            const selected = selectedAllocations.find((allocation) => allocation.provider_id === providerId && allocation.provider_model_id === null);
            return <div className="payment-field-allocation-row fallback" key={`${providerId}:default`}>
              <strong>{group.provider_name}</strong><span>Default for unmapped models</span>
              <select className="select" defaultValue={selected?.provider_metric_id ? `${providerId}||${selected.provider_metric_id}` : ""} name={`provider_metric_${providerId}_default`}>
                <option value="">Not used</option>{options.map((metric) => <option key={metric.id} value={`${providerId}||${metric.id}`}>{metric.name}</option>)}
              </select>
            </div>;
          })}
          {!providerMetrics.length ? <p className="payment-field-calculation-help">No provider production counts are configured. Add them in Provider Master first.</p> : null}
          <div className="payment-field-calculation-help">Allocate a production count separately for each provider and operating model. The individual rate is entered for each DropX ID in ID &amp; pay mapping.</div>
        </> : <>
          <input name="calculation_source" type="hidden" value="" />
          <p className="payment-field-calculation-help">The configured amount in ID &amp; pay mapping will be used directly.</p>
        </>}
      </div>

      <div className="payment-field-form-actions"><SubmitButton className="button compact">{submitLabel}</SubmitButton></div>
    </form>
  );
}
