"use client";

import { useState } from "react";

type PayoutPeriodMode = "monthly" | "daily" | "range";

type WorkforcePayoutPeriodFilterProps = {
  audience?: "workforce" | "helpers";
  mode: PayoutPeriodMode;
  month: string;
  day: string;
  from: string;
  to: string;
};

export function WorkforcePayoutPeriodFilter({ audience = "workforce", mode: initialMode, month, day, from, to }: WorkforcePayoutPeriodFilterProps) {
  const [mode, setMode] = useState<PayoutPeriodMode>(initialMode);
  const [selectedMonth, setSelectedMonth] = useState(month);
  const [selectedDay, setSelectedDay] = useState(day);
  const [selectedFrom, setSelectedFrom] = useState(from);
  const [selectedTo, setSelectedTo] = useState(to);

  return <form className="payout-period-filter" method="get">
    <input name="audience" type="hidden" value={audience} />
    <label>
      View by
      <select className="field" name="period" value={mode} onChange={(event) => setMode(event.target.value as PayoutPeriodMode)}>
        <option value="monthly">Month</option>
        <option value="daily">Single day</option>
        <option value="range">Date range</option>
      </select>
    </label>
    {mode === "monthly" ? <label>
      Month
      <input className="field" type="month" name="month" value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)} />
    </label> : null}
    {mode === "daily" ? <label>
      Day
      <input className="field" type="date" name="day" value={selectedDay} onChange={(event) => setSelectedDay(event.target.value)} />
    </label> : null}
    {mode === "range" ? <>
      <label>
        From
        <input className="field" type="date" name="from" value={selectedFrom} onChange={(event) => setSelectedFrom(event.target.value)} />
      </label>
      <label>
        To
        <input className="field" type="date" name="to" value={selectedTo} onChange={(event) => setSelectedTo(event.target.value)} />
      </label>
    </> : null}
    {mode !== "monthly" ? <input type="hidden" name="month" value={selectedMonth} /> : null}
    {mode !== "daily" ? <input type="hidden" name="day" value={selectedDay} /> : null}
    {mode !== "range" ? <><input type="hidden" name="from" value={selectedFrom} /><input type="hidden" name="to" value={selectedTo} /></> : null}
    <button className="button secondary" type="submit">Apply period</button>
  </form>;
}
