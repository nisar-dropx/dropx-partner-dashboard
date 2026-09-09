import { createHash } from "node:crypto";
export type ThreadMode = "monthly" | "new";
/** The report month controls daily digests; other event types pass their event date. */
export function notificationThreadPolicy(input: {
  companyId: string; portal: string; eventKey: string; to: string[]; cc?: string[];
  reportDate: string; title: string; mode?: ThreadMode;
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.reportDate) || !Number.isFinite(Date.parse(input.reportDate))
    || new Date(input.reportDate).toISOString().slice(0,10)!==input.reportDate) throw Error("A valid report date is required for email threading.");
  if (!input.companyId || !input.portal || !input.eventKey || !input.title.trim()) throw Error("Notification identity is required.");
  const addresses=(list:string[])=>[...new Set(list.map(s=>s.trim().toLowerCase()))].sort();
  const to=addresses(input.to),cc=addresses(input.cc??[]);
  if(!to.length || [...to,...cc].some(s=>! /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s))) throw Error("Valid recipient addresses are required.");
  const month=input.reportDate.slice(0,7), label=new Date(input.reportDate+"T12:00:00Z").toLocaleDateString("en-GB",{month:"long",year:"numeric",timeZone:"Asia/Kolkata"});
  const key=createHash("sha256").update(JSON.stringify([input.companyId,input.portal,input.eventKey,to,cc,month])).digest("hex");
  return {key,month,subject:input.title.replace(/[\r\n]/g," ").trim()+" | "+label,reuseThread:(input.mode??"monthly")==="monthly"};
}
