"use client";
import { ReportTable } from "@/components/report-table";


import { useState } from "react";

type Metric = { source_key: string; label: string };

function MetricSum({ name, label, metrics, onChange }: {
  name: string; label: string; metrics: Metric[]; onChange: (values: string[]) => void;
}) {
  const [terms, setTerms] = useState([{ id: 0, value: "" }]);
  const [nextId, setNextId] = useState(1);
  function update(next: typeof terms) { setTerms(next); onChange(next.map(term => term.value)); }
  return <fieldset style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, minWidth: 0 }}>
    <legend>{label}</legend>
    {terms.map((term, index) => <div key={term.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
      {index > 0 ? <span aria-hidden="true">+</span> : null}
      <select className="select" name={name} aria-label={`${label} metric ${index + 1}`} required value={term.value}
        onChange={event => update(terms.map(item => item.id === term.id ? { ...item, value: event.target.value } : item))}>
        <option value="" disabled>Select metric</option>
        {metrics.map(metric => <option key={metric.source_key} value={metric.source_key}
          disabled={terms.some(item => item.id !== term.id && item.value === metric.source_key)}>{metric.label}</option>)}
      </select>
      {terms.length > 1 ? <button type="button" className="button secondary compact" aria-label={`Remove ${label} metric ${index + 1}`}
        onClick={() => update(terms.filter(item => item.id !== term.id))}>Remove</button> : null}
    </div>)}
    <button type="button" className="button secondary compact" disabled={terms.length >= metrics.length}
      onClick={() => { update([...terms, { id: nextId, value: "" }]); setNextId(nextId + 1); }}>Add {name === "numerator_source" ? "numerator" : "denominator"} metric</button>
  </fieldset>;
}

export function ConversionFormulaFields({ metrics }: { metrics: Metric[] }) {
  const [numerator, setNumerator] = useState<string[]>([]);
  const [denominator, setDenominator] = useState<string[]>([]);
  const describe = (values: string[], placeholder: string) => values.filter(Boolean).map(value => metrics.find(metric => metric.source_key === value)?.label ?? value).join(" + ") || placeholder;
  return <>
    <MetricSum name="numerator_source" label="Conversion numerator (completed count)" metrics={metrics} onChange={setNumerator} />
    <MetricSum name="denominator_source" label="Conversion denominator (base count)" metrics={metrics} onChange={setDenominator} />
    <p className="subtle" style={{ gridColumn: "1 / -1" }} aria-live="polite">Conversion = ({describe(numerator, "completed counts")}) ÷ ({describe(denominator, "base counts")}) × 100. Each side sums its selected metrics.</p>
  </>;
}

export function ConversionSlabFields() {
  const [rows, setRows] = useState([0]);
  const [nextId, setNextId] = useState(1);
  return <>
    <h3>Conversion slabs</h3><p className="subtle">Start at 0%. Each rate applies up to the next minimum. Add or remove rows as needed (up to 20).</p>
    <div className="table-wrap"><ReportTable><thead><tr><th>Minimum conversion % (inclusive)</th><th>Rate per production unit (₹)</th><th>Action</th></tr></thead><tbody>
      {rows.map((id, index) => <tr key={id}><td><input className="field" aria-label={`Slab ${index + 1} minimum conversion`} type="number" name="minimum" min="0" max="100" step="0.01" defaultValue={id === 0 ? 0 : undefined} readOnly={id === 0} required /></td>
        <td><input className="field" aria-label={`Slab ${index + 1} rate`} type="number" name="rate" min="0" step="0.01" required /></td>
        <td>{id !== 0 ? <button type="button" className="button secondary compact" aria-label={`Remove slab ${index + 1}`} onClick={() => setRows(rows.filter(row => row !== id))}>Remove</button> : <span className="subtle">Base slab</span>}</td></tr>)}
    </tbody></ReportTable></div>
    <button type="button" className="button secondary compact" disabled={rows.length >= 20} onClick={() => { setRows([...rows, nextId]); setNextId(nextId + 1); }}>Add slab row</button>
  </>;
}
