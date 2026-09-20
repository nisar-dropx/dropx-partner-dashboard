import { SubmitButton } from "@/components/submit-button";
import { updateReviewMetricTarget } from "@/app/master/performance-targets/actions";
import { hawkeyeMetricDefinitions, hawkeyeTargetKey } from "@/lib/ops-pulse/hawkeye";
import { resolvePerformanceTargets, type PerformanceTarget } from "@/lib/ops-pulse/performance-targets";

export function PerformanceReviewTargetMaster({rows,canEdit}:{rows:PerformanceTarget[];canEdit:boolean}) {
  const effective=resolvePerformanceTargets(rows,"daily");
  return <section className="panel"><div className="panel-head"><div><h2>Review scorecard targets</h2><p className="subtle">All thresholds are editable here. Enter percentages from 0 to 100. Existing SLS targets are linked; saving updates their source master. Blank means no configured target.</p></div></div>
    <div className="review-target-metric-list">{hawkeyeMetricDefinitions.map(definition=>{
      const key=hawkeyeTargetKey(definition),target=effective.find(row=>row.metricKey===key);
      const daily=rows.find(row=>row.reportType==="daily"&&row.metricKey===key);
      const inherited=(!daily || (daily.target==null&&!daily.explicitReviewTarget)) && rows.some(row=>row.reportType==="sls"&&row.metricKey===key&&row.unit==="percent"&&row.isActive&&row.target!=null);
      return <form action={updateReviewMetricTarget} key={key} className="review-target-metric-row">
        <input type="hidden" name="metric_key" value={key}/>
        <strong>{definition.short}<small className="subtle">{inherited ? "Linked to SLS master" : target?.target==null ? "Target not configured" : "Daily / review master"}</small></strong>
        <label><span className="sr-only">{definition.short} target percentage</span><input name="target_pct" type="number" min="0" max="100" step="0.001" placeholder="No target" defaultValue={target?.target==null?"":Number((target.target*100).toFixed(4))}/><small>%</small></label>
        <label><span className="sr-only">{definition.short} target direction</span><select name="direction" defaultValue={target?.direction||"higher"}><option value="higher">At least (≥)</option><option value="lower">At most (≤)</option></select></label>
        <SubmitButton disabled={!canEdit}>Save</SubmitButton>
      </form>;
    })}</div>
  </section>;
}
