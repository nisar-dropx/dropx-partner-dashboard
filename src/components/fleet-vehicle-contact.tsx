"use client";
import { useState, type FormEvent } from "react";
import { FleetODCDDALink } from './fleet-odcd-da-link';
import { UserRound } from "lucide-react";
import type { FleetControlVehicle } from "@/lib/fleet-control";
type Contacts = Pick<FleetControlVehicle, "vehicleNo" | "model" | "fuelType" | "daName" | "daContactNumber" | "vendorName" | "vendorContactNumber">;
export function FleetVehicleContactFields({source,vehicle,disabled=false}:{source:string;vehicle?:FleetControlVehicle;disabled?:boolean}) {
  if(source === "own")return null;
  const da=source === "odcd";
  return <><label><span>{da ? "Owner-driver contact name" : "Vendor Name"}</span><input name={da ? "da_name" : "vendor_name"} defaultValue={(da ? vehicle?.daName : vehicle?.vendorName) ?? ""} maxLength={160} placeholder={da ? "Enter owner-driver name" : "Enter vendor name"} disabled={disabled} /></label><label><span>Contact Number</span><input name={da ? "da_contact_number" : "vendor_contact_number"} defaultValue={(da ? vehicle?.daContactNumber : vehicle?.vendorContactNumber) ?? ""} type="tel" inputMode="tel" autoComplete="tel" maxLength={24} placeholder="Mobile number" disabled={disabled} /></label></>;
}
export function FleetVehicleContactEditor({vehicle,canEdit,onSaved}:{vehicle:FleetControlVehicle;canEdit:boolean;onSaved:(values:Contacts)=>void}) {
 const [saving,setSaving]=useState(false);const [message,setMessage]=useState<{error:boolean;text:string}|null>(null);
 async function save(event:FormEvent<HTMLFormElement>){
  event.preventDefault();const form=new FormData(event.currentTarget);if(!form.get('fuel_type'))form.delete('fuel_type');setSaving(true);setMessage(null);
  try {
   const response=await fetch('/api/fleet/vehicles',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({vehicle_no:vehicle.vehicleNo,...Object.fromEntries(form.entries())})});
   const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not save vehicle details.');
   onSaved({vehicleNo:result.vehicle.vehicle_no,model:result.vehicle.model,fuelType:result.vehicle.fuel_type,daName:result.vehicle.da_name,daContactNumber:result.vehicle.da_contact_number,vendorName:result.vehicle.vendor_name,vendorContactNumber:result.vehicle.vendor_contact_number});
   setMessage({error:false,text:'Vehicle details saved.'});
  }catch(error){setMessage({error:true,text:error instanceof Error?error.message:'Could not save vehicle details.'});}finally{setSaving(false);}
 }
 return <section className="fc-manage-card"><div className="fc-manage-card-head"><span><UserRound size={17}/></span><div><strong>Vehicle details</strong><small>Registration, model and contact details</small></div></div><form className="fc-placement-form" onSubmit={save}><div className="fc-placement-grid">{vehicle.vehicleNo.startsWith('PENDING-')?<label><span>Registration number</span><input name="registration_number" placeholder="Optional · add when available" disabled={!canEdit||saving}/></label>:<label><span>Registration number</span><input value={vehicle.vehicleNo} readOnly disabled/></label>}<label><span>Vehicle model</span><input name="model" required defaultValue={vehicle.model} maxLength={160} placeholder="e.g. Mahindra Jeeto" disabled={!canEdit||saving}/></label><label><span>Fuel type</span><select name="fuel_type" defaultValue={vehicle.fuelType==='Not recorded'?'':vehicle.fuelType} disabled={!canEdit||saving}><option value="">Not recorded</option>{['Diesel','Petrol','CNG','EV'].map(f=><option key={f}>{f}</option>)}</select></label><FleetVehicleContactFields source={vehicle.ownershipType} vehicle={vehicle} disabled={!canEdit||saving}/></div>{canEdit&&<button className="fc-button primary" type="submit" disabled={saving}>{saving?'Saving…':'Save vehicle details'}</button>}{message&&<p role={message.error?'alert':'status'} style={{color:message.error?'#be123c':'#137660'}}>{message.text}</p>}</form>{vehicle.ownershipType==='odcd'&&<FleetODCDDALink vehicleId={vehicle.id} station={vehicle.stationCode}/>}</section>;
}
