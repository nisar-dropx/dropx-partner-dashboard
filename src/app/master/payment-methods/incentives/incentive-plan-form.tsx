"use client";

import { useMemo, useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { createIncentivePlan } from "./actions";

type Option = { id: string; code: string; name: string };
type ModelOption = Option & { provider_id: string | null };
type StationOption = { id: string; station_code: string; station_name: string; provider_id: string | null; location_model_id: string | null };
type PlanType = "attendance" | "conversion" | "performance";

export function IncentivePlanForm({ providers, models, stations, designations }: {
  providers: Option[];
  models: ModelOption[];
  stations: StationOption[];
  designations: Option[];
}) {
  const [type, setType] = useState<PlanType>("attendance");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [attendanceRequired, setAttendanceRequired] = useState(true);
  const [reportingRequired, setReportingRequired] = useState(true);
  const [thresholdType, setThresholdType] = useState<"minimum_days" | "maximum_absent_days">("minimum_days");
  const [rewardType, setRewardType] = useState<"flat" | "per_shipment">("per_shipment");
  const [cycle, setCycle] = useState("half_monthly");
  const visibleModels = useMemo(() => models.filter((model) => !providerId || model.provider_id === providerId), [models, providerId]);
  const visibleStations = useMemo(() => stations.filter((station) =>
    (!providerId || station.provider_id === providerId) && (!modelId || station.location_model_id === modelId)), [stations, providerId, modelId]);

  return <form action={createIncentivePlan} className="panel-body" style={{ display: "grid", gap: 16 }}>
    <div className="form-grid three">
      <label>Plan name<input name="name" placeholder="Name this policy" required /></label>
      <label>Incentive type<select name="incentive_type" value={type} onChange={(event) => setType(event.target.value as PlanType)}><option value="attendance">Attendance / reporting time</option><option value="conversion">Conversion</option><option value="performance">Production performance</option></select></label>
      <label>Status<select name="status" defaultValue="draft"><option value="draft">Draft</option><option value="active">Active</option><option value="paused">Paused</option></select></label>
    </div>

    <fieldset><legend>1. Apply to</legend>
      <div className="form-grid four">
        <label>Provider<select name="provider_id" value={providerId} onChange={(event) => { setProviderId(event.target.value); setModelId(""); }} required><option value="" disabled>Select provider</option>{providers.map((row) => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}</select></label>
        <label>Model<select name="location_model_id" value={modelId} onChange={(event) => setModelId(event.target.value)}><option value="">All models</option>{visibleModels.map((row) => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}</select></label>
        <label>Station<select name="station_id" defaultValue=""><option value="">All locations in scope</option>{visibleStations.map((row) => <option key={row.id} value={row.id}>{row.station_code} · {row.station_name}</option>)}</select></label>
        <label>Designation<select name="designation_id" required defaultValue=""><option value="" disabled>Select designation</option>{designations.map((row) => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}</select></label>
      </div>
    </fieldset>

    {type === "attendance" ? <fieldset><legend>2. Qualification</legend>
      <div className="form-grid three">
        <label>Salary cycle<select name="cycle_type" value={cycle} onChange={(event) => setCycle(event.target.value)}><option value="half_monthly">1–15 / 16–month end</option><option value="monthly">Monthly</option></select></label>
        <label style={{ alignContent: "end" }}><span><input name="attendance_required" type="checkbox" checked={attendanceRequired} onChange={(event) => setAttendanceRequired(event.target.checked)} /> Attendance days</span></label>
        <label style={{ alignContent: "end" }}><span><input name="reporting_time_required" type="checkbox" checked={reportingRequired} onChange={(event) => setReportingRequired(event.target.checked)} /> Reporting time</span></label>
      </div>
      {!attendanceRequired && !reportingRequired ? <p className="message-panel error">Enable Attendance days, Reporting time, or both.</p> : null}
      {attendanceRequired ? <div className="form-grid three">
        <label>Attendance rule<select name="attendance_threshold_type" value={thresholdType} onChange={(event) => setThresholdType(event.target.value as typeof thresholdType)}><option value="minimum_days">Minimum present days</option><option value="maximum_absent_days">Maximum days absent</option></select></label>
        {thresholdType === "minimum_days" ? <label>Minimum present days<input key={`present-${cycle}`} name="minimum_present_days" min="1" step="1" type="number" defaultValue={cycle === "monthly" ? 26 : 13} required /></label> : <label>Maximum days absent<input key={`absent-${cycle}`} name="maximum_absent_days" min="0" step="1" type="number" defaultValue={cycle === "monthly" ? 4 : 2} required /></label>}
      </div> : null}
      {reportingRequired ? <div className="form-grid three">
        <label>Punch in by (IST)<input name="reporting_time" type="time" defaultValue="07:30" required /></label>
        <label>Allowed cutoff misses<input key={`misses-${cycle}`} name="allowed_late_days" min="0" step="1" type="number" defaultValue={cycle === "monthly" ? 4 : 2} required /></label>
      </div> : null}
      <p className="subtle">Eligibility uses verified biometric punch-ins. Attendance and cutoff rules can run separately or together.</p>
    </fieldset> : null}

    {type === "conversion" ? <fieldset><legend>2. Conversion slabs</legend><div className="form-grid four">{[1, 2, 3, 4].map((row) => <div key={row}><label>Minimum %<input name="tier_minimum" min="0" max="100" step="0.01" type="number" /></label><label>Bonus amount<input name="tier_amount" min="0" step="0.01" type="number" /></label></div>)}</div></fieldset> : null}

    {type === "performance" ? <fieldset><legend>2. Performance rule</legend><div className="form-grid three">
      <label>Cycle<select name="cycle_type" defaultValue="daily"><option value="daily">Daily</option><option value="half_monthly">1–15 / 16–month end</option><option value="monthly">Monthly</option></select></label>
      <label>Metric<select name="metric" defaultValue="total_delivery"><option value="total_delivery">Total delivery</option><option value="total_activity">Total activity</option><option value="amazon_delivery">Amazon delivery</option><option value="swa_delivery">SWA delivery</option><option value="c_return">Customer return</option><option value="mfn">MFN</option></select></label>
      <label>Calculation<select name="calculation_type" defaultValue="flat_threshold"><option value="flat_threshold">Flat amount on target</option><option value="per_unit_above_threshold">Per unit above target</option></select></label>
      <label>Target<input name="threshold_value" min="0" step="0.01" type="number" defaultValue="0" /></label>
      <label>Minimum activity<input name="minimum_activity" min="0" step="1" type="number" defaultValue="0" /></label>
      <label>Rate per unit<input name="rate_value" min="0" step="0.01" type="number" defaultValue="0" /></label>
      <label>Flat bonus<input name="flat_amount" min="0" step="0.01" type="number" defaultValue="0" /></label>
    </div></fieldset> : null}

    {type === "attendance" ? <fieldset><legend>3. Reward</legend><div className="form-grid three">
      <label>Reward method<select name="attendance_reward_type" value={rewardType} onChange={(event) => setRewardType(event.target.value as typeof rewardType)}><option value="per_shipment">Amount per delivered shipment</option><option value="flat">Flat cycle bonus</option></select></label>
      {rewardType === "per_shipment" ? <label>Amount per shipment<input name="rate_value" min="0.01" step="0.01" type="number" required /></label> : <label>Flat bonus<input name="flat_amount" min="0.01" step="0.01" type="number" required /></label>}
      <label>Maximum per cycle (optional)<input name="maximum_amount" min="0" step="0.01" type="number" /></label>
    </div></fieldset> : <input name="maximum_amount" type="hidden" value="" />}

    <fieldset><legend>{type === "attendance" ? "4" : "3"}. Effective period</legend><div className="form-grid three"><label>Effective from<input name="effective_from" type="date" required /></label><label>Effective to<input name="effective_to" type="date" required /></label><label>Policy note (optional)<input name="description" /></label></div></fieldset>

    <details><summary>Internal reference</summary><div className="form-grid three" style={{ marginTop: 12 }}><label>Plan code (optional)<input name="code" placeholder="Generated when blank" /></label></div></details>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      {type === "attendance" ? <span className="subtle">{attendanceRequired && reportingRequired ? "Attendance + reporting time" : attendanceRequired ? "Attendance only" : "Reporting time only"} · {cycle === "monthly" ? "monthly" : "15-day"} · {rewardType === "per_shipment" ? "per shipment" : "flat bonus"}</span> : <span />}
      <SubmitButton disabled={type === "attendance" && !attendanceRequired && !reportingRequired}>Save plan</SubmitButton>
    </div>
  </form>;
}
