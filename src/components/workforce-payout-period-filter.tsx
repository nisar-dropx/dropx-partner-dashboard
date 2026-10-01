"use client";

import { useState } from "react";

type PayoutPeriodMode = "monthly" | "daily" | "range";

type WorkforcePayoutPeriodFilterProps = {
  mode: PayoutPeriodMode;
  month: string;
  day: string;
  from: string;
  to: string;
};

export function WorkforcePayoutPeriodFilter({ mode: initialMode, month, day, from, to }: WorkforcePayoutPeriodFilterProps) {
  const [mode, setMode] = useState<PayoutPeriodMode>(initialMode);

  return <form className="payout-period-filter" method="get">
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
      <input className="field" type="month" name="month" defaultValue={month} />
    </label> : null}
    {mode === "daily" ? <label>
      Day
      <input className="field" type="date" name="day" defaultValue={day} />
    </label> : null}
    {mode === "range" ? <>
      <label>
        From
        <input className="field" type="date" name="from" defaultValue={from} />
      </label>
      <label>
        To
        <input className="field" type="date" name="to" defaultValue={to} />
      </label>
    </> : null}
    <button className="button secondary" type="submit">Apply period</button>
  </form>;
}
