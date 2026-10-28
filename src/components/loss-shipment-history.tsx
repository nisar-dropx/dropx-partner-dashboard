"use client";
import { LossPidTimeline } from "./loss-pid-timeline";
import styles from "./nl-loss.module.css";

export function lossUpdateTime(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true, timeZone: "Asia/Kolkata",
  }) + " IST";
}
export function LossShipmentHistory({ month, caseKey, tid }: { month: string; caseKey: string; tid: string }) {
  return <section className={styles.shipmentHistory} aria-label={`Shipment history for tracking ID ${tid}`}>
    <LossPidTimeline month={month} caseKey={caseKey} initiallyOpen embedded title={`Shipment history · ${tid}`} />
  </section>;
}
