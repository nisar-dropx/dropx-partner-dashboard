"use client";
import {useState} from "react";
import {lossDisputeReduction} from "../lib/payout-dispute-balance";
import s from "./guided-dispute.module.css";
export function DisputeBalanceChoice({plan,onChange}:{plan:any;onChange?:(value:{treatment:string;reason:string})=>void}){
 const [treatment,setTreatment]=useState(""),[reason,setReason]=useState("");
 const amount=lossDisputeReduction(plan);if(!amount)return null;
 return <fieldset className={s.balance}><legend>Reduced loss · ₹{amount.toLocaleString("en-IN")}</legend><label>Balance treatment<select name="loss_balance_treatment" value={treatment} required onChange={e=>{setTreatment(e.target.value);onChange?.({treatment:e.target.value,reason});}}><option value="">Choose</option><option value="outstanding">Keep outstanding</option><option value="write_off">Write off</option></select></label><input name="loss_balance_reason" aria-label="Loss balance reason" placeholder="Reason for this decision" value={reason} minLength={10} maxLength={1000} required onChange={e=>{setReason(e.target.value);onChange?.({treatment,reason:e.target.value});}}/></fieldset>;
}
