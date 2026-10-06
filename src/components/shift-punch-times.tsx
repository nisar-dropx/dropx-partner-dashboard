const formatter = new Intl.DateTimeFormat("en-IN", {
  hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata"
});

function punchTime(value: string | null) {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? formatter.format(timestamp) : "—";
}

/** Actual punch evidence stays visible independently of roster approval. */
export function ShiftPunchTimes({ inTime, outTime }: { inTime: string | null; outTime: string | null }) {
  if (!inTime && !outTime) return <b>—</b>;
  return <>
    <b title={inTime ?? "No IN punch"}>IN {punchTime(inTime)}</b>
    <b title={outTime ?? "No OUT punch"}>OUT {outTime ? punchTime(outTime) : "pending"}</b>
  </>;
}
