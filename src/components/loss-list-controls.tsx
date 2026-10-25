"use client";
import "./loss-list-controls.css";
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FleetMultiSelect, type FleetFilterOption } from "./fleet-multi-select";
import { lossFilterValue, lossFilterValues, LOSS_SORTS } from "@/lib/ops-pulse/loss-list-controls";

export function LossMultiFilter({ name, label, value, options, allLabel }: { name: string; label: string; value: string; options: FleetFilterOption[]; allLabel: string }) {
  const [values, setValues] = useState(() => lossFilterValues(value));
  return <div className="loss-multi-filter"><input type="hidden" name={name} value={lossFilterValue(values)} /><FleetMultiSelect label={label} allLabel={allLabel} options={options} values={values} onChange={setValues} /></div>;
}
export function LossTableSort({ value = "value_desc" }: { value?: string }) {
  const router = useRouter(), pathname = usePathname(), params = useSearchParams();
  return <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12}}>Sort <select aria-label="Sort station table" value={value} onChange={e => { const q = new URLSearchParams(params.toString()); q.set("sort", e.target.value); router.push(`${pathname}?${q}`); }}>{LOSS_SORTS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select></label>;
}
