"use client";

import { useState } from "react";
import { PAYOUT_DISPUTE_AREAS } from "@/lib/payout-dispute-areas";
import { buildDisputeCorrectionPlan, type DisputeCorrectionField } from "@/lib/payout-dispute-corrections";
import styles from "./payout-review-desk.module.css";

export function PayoutDisputeCorrectionInputs({ fields }: { fields: DisputeCorrectionField[] }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const form = new FormData();
  for (const field of fields) form.set(`corrected_${field.area}`, values[field.area] ?? "");
  const complete = fields.every(field => Boolean(values[field.area]?.trim()));
  let plan: ReturnType<typeof buildDisputeCorrectionPlan> | null = null;
  let error = "";
  if (complete) {
    try { plan = buildDisputeCorrectionPlan(fields, form); }
    catch (cause) { error = cause instanceof Error ? cause.message : "The change could not be calculated."; }
  }
  return <>
    <p className={styles.correctionHelp}>Selected in DropX One. Current values and rates are from the disputed payout revision.</p>
    {fields.map(field => <fieldset className={styles.correctionItem} key={field.area}>
      <legend>{field.label}</legend>
      <label>Disputed item
        <select aria-label={`Disputed item: ${field.label}`} value={field.area} disabled>
          {field.area === "legacy" ? <option value="legacy">{field.label}</option> : PAYOUT_DISPUTE_AREAS.map(area => <option key={area.value} value={area.value}>{area.label}</option>)}
        </select>
      </label>
      <label>Current value ({field.unit === "rupees" ? "₹" : field.unit})
        <input value={field.currentValue ?? "Not available in published payout"} readOnly aria-label={`Current value: ${field.label}`} />
      </label>
      <label>Corrected value ({field.unit === "rupees" ? "₹" : field.unit})
        <input name={`corrected_${field.area}`} value={values[field.area] ?? ""} onChange={event => setValues(current => ({ ...current, [field.area]: event.target.value }))}
          type="number" min="0" step="0.01" required disabled={field.currentValue === null} aria-label={`Corrected value: ${field.label}`} />
      </label>
      <p className={styles.correctionHelp}>
        {field.unitRate === null ? field.rateIssue || "The published rate is unavailable." : field.unit === "rupees"
          ? field.area === "deduction" ? "Reducing this deduction increases net pay; increasing it reduces net pay." : "Change = corrected amount − current amount."
          : `Published rate: ₹${field.unitRate} / ${field.unit === "days" ? "day" : "unit"}. Change = (corrected − current) × rate.`}
        {plan ? ` Item net change: ₹${(plan.items.find(item => item.area === field.area)!.expected_delta_paise / 100).toFixed(2)}.` : ""}
      </p>
    </fieldset>)}
    <label className={styles.correctionHelp}>Exact expected net change (₹)
      <input name="expected_delta_rupees" value={plan ? (plan.expected_delta_paise / 100).toFixed(2) : ""} readOnly
        placeholder="Calculated from corrected values and payout rates" aria-label="Expected net change in rupees" />
    </label>
    {error ? <p role="alert" className={styles.correctionHelp}>{error}</p> : null}
    <textarea name="note" required minLength={10} maxLength={1000} placeholder="Correction explanation the associate will see (at least 10 characters)" aria-label="Correction note" />
    <button className="button" name="transition" value="propose_correction" disabled={!plan}>Send for final approval</button>
  </>;
}
