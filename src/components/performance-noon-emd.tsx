import type { PerformanceNoonEmd } from "@/lib/ops-pulse/performance-review";
import { savePerformanceNoonEmd } from "@/app/ops-pulse/performance/actions";
import { ReviewActionForm } from "@/components/review-action-form";
import {TrendButton} from "@/components/performance-trends";

export function PerformanceNoonEmdEntry({entry,date,stationCode,canEdit,error,target=null}:{entry:PerformanceNoonEmd|null;date:string;stationCode:string;canEdit:boolean;error:string|null;target?:number|null}) {
  return <section className="review-noon-emd" aria-label="EMD at 12 p.m.">
    <div><h3>EMD at 12 p.m. (%)</h3><p>Station total · {date.split("-").reverse().join("/")}</p><TrendButton group="station" metric="emd" label="EMD at 12 p.m."/></div>
    <small className={entry?.emd_noon_pct!=null&&target!=null?(entry.emd_noon_pct>=target?"review-target-met":"review-target-missed"):""}>{target==null?"Station target not configured":`Target ≥ ${target}%${entry?.emd_noon_pct!=null ? entry.emd_noon_pct>=target ? " · Achieved" : " · Below target" : ""}`}</small>
    {error?<p role="alert">{error}</p>:canEdit?<ReviewActionForm action={savePerformanceNoonEmd} key={`${stationCode}-${date}-${entry?.version??0}`}>
      <input type="hidden" name="station_code" value={stationCode}/><input type="hidden" name="source_date" value={date}/><input type="hidden" name="version" value={entry?.version??0}/>
      <label><span className="sr-only">EMD at 12 p.m. percentage</span><input name="emd_noon_pct" type="number" inputMode="decimal" min={0} max={100} step="0.01" required placeholder="0–100" defaultValue={entry?.emd_noon_pct??""}/></label><button className="button secondary">Save EMD</button>
    </ReviewActionForm>:<strong>{entry?.emd_noon_pct==null?"Not entered":`${entry.emd_noon_pct}%`}</strong>}
    {entry?<small>Updated by {entry.updated_by_name} · {new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}).format(new Date(entry.updated_at))}</small>:null}
  </section>;
}
