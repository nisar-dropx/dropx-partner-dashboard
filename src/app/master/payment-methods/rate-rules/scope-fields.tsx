"use client";

import { useState } from "react";

export function ConversionScopeFields({ methods, fields, models, stations }: {
  methods: { id: string; name: string; payment_method_components: { payment_field_id: string; is_active: boolean }[] }[];
  fields: { id: string; label: string }[];
  models: { id: string; code: string; name: string }[];
  stations: { id: string; station_code: string; station_name: string; location_model_id: string }[];
}) {
  const [methodId, setMethodId] = useState("");
  const [modelId, setModelId] = useState("");
  const selectedFields = new Set((methods.find(method => method.id === methodId)?.payment_method_components ?? [])
    .filter(component => component.is_active).map(component => component.payment_field_id));
  return <>
    <label>Payment method<select className="select" name="payment_method_id" required value={methodId} onChange={event => setMethodId(event.target.value)}><option value="" disabled>Select method</option>{methods.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
    <label>Production field<select className="select" key={methodId} name="payment_field_id" required defaultValue="" disabled={!methodId}><option value="" disabled>Select production field</option>{fields.filter(row => selectedFields.has(row.id)).map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
    <label>Operating model<select className="select" name="location_model_id" required value={modelId} onChange={event => setModelId(event.target.value)}><option value="" disabled>Select model</option>{models.map(row => <option key={row.id} value={row.id}>{row.code} — {row.name}</option>)}</select></label>
    <label>Location<select className="select" key={modelId} name="station_id" required defaultValue="" disabled={!modelId}><option value="" disabled>Select location within model</option>{stations.filter(row => row.location_model_id === modelId).map(row => <option key={row.id} value={row.id}>{row.station_code} — {row.station_name}</option>)}</select></label>
  </>;
}
