import { formatDashboardDateTime } from "@/lib/date-format";
import type { ResubmissionContext } from "@/lib/payment-resubmission-context";
export function PaymentResubmissionContext({ context, location, head, amount, payout = false }: {
  context: ResubmissionContext; location: string; head: string; amount: number | null; remarks: string | null; payout?: boolean;
}) {
  const returned = context.returned;
  const reason = returned?.comments?.replace(/^returned:\s*/i, "").trim();
  const usefulReason = reason || null;
  return <div className="resubmit-context">
    <div className="resubmit-facts"><strong>{head}</strong><span>{location}</span><span>Requested ₹{Number(amount ?? 0).toLocaleString("en-IN")}</span><span className="resubmit-stage">{payout ? "Payment correction" : "Expense correction"}</span></div>
    <div className="resubmit-return" role="note">
      <div><strong>Returned{returned ? ` by ${returned.actor}` : " for correction"}</strong>{returned ? <small>{returned.role ? `${returned.role} · ` : ""}{formatDashboardDateTime(returned.created_at)} IST</small> : null}</div>
      <p>{usefulReason || "No specific return reason was recorded. Check with the reviewer before resubmitting."}</p>
    </div>
    {context.vehicleContext.length ? <p className="resubmit-vehicle"><strong>Vehicle context</strong> {context.vehicleContext.join(" · ")}</p> : null}
    {context.error ? <p role="alert" className="resubmit-error">{context.error}</p> : null}
    <details className="resubmit-disclosure">
      <summary>Request journey <span>{context.events.length} events · who, when & why</span></summary>
      <ol className="resubmit-timeline">{context.events.map(event => <li key={event.id}>
        <div><strong>{String(event.action || "Updated").replace(/_/g, " ")}</strong><time>{formatDashboardDateTime(event.created_at)} IST</time></div>
        <small>{event.actor}{event.role ? ` · ${event.role}` : ""}</small>
        {event.comments ? <p>{event.comments}</p> : null}
      </li>)}</ol>
    </details>
  </div>;
}
