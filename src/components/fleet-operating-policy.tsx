"use client";
import { type FormEvent } from "react";
import { normalizeFleetOperatingPolicy, type FleetOperatingPolicy } from "@/lib/fleet/operating-policy";

export function FleetOperatingPolicyEditor({value,canEdit,busy,onSave}:{value?:FleetOperatingPolicy;canEdit:boolean;busy:boolean;onSave:(value:FleetOperatingPolicy)=>Promise<unknown>}) {
  const policy=normalizeFleetOperatingPolicy(value);
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    await onSave({availabilityTargetPercent:Number(form.get("availabilityTargetPercent")),serviceWorkTypes:String(form.get("serviceWorkTypes")||"").split("\n").map(v=>v.trim()).filter(Boolean)});
  }
  return <article className="fc-panel fc-settings-card"><div className="fc-panel-head"><div><span className="fc-eyebrow">Operating controls</span><h2>Availability & service categories</h2><p>Used by Command Center and both service forms. Existing work records keep their original category.</p></div></div><form className="fc-settings-form fc-operating-policy-form" onSubmit={submit} key={JSON.stringify(policy)}><fieldset disabled={!canEdit||busy} style={{border:0,padding:0,margin:0,display:"grid",gap:16}}><label><span>Availability target (%)</span><input name="availabilityTargetPercent" type="number" min="1" max="100" step="0.1" required defaultValue={policy.availabilityTargetPercent}/></label><label><span>Service work categories · one per line</span><textarea name="serviceWorkTypes" rows={7} required defaultValue={policy.serviceWorkTypes.join("\n")}/><small>First category is the default. Add, rename or remove choices here.</small></label>{canEdit?<button className="fc-button primary" type="submit">{busy?"Saving…":"Save operating controls"}</button>:null}</fieldset></form></article>;
}
