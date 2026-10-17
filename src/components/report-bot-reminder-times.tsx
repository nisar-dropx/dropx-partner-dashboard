"use client";

import { useState } from "react";
import { Repeat } from "lucide-react";
import s from "@/app/ops-pulse/report-bot/report-bot.module.css";
import { intervalTimes } from "@/lib/report-bot/logic";

/** Reminder-times box with a helper that fills it at a fixed interval (e.g. 09:00 to 18:00 every 30 minutes). */
export function ReminderTimesField({ defaultValue }: { defaultValue: string }) {
  const [value, setValue] = useState(defaultValue);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("18:00");
  const [every, setEvery] = useState("30");
  const [error, setError] = useState<string | null>(null);
  const fill = () => {
    const times = intervalTimes(start, end, Number(every));
    if (!times) {
      setError("Choose a start before the end, and an interval of at least 1 minute.");
      return;
    }
    setError(null);
    setValue(times.join(", "));
  };
  const count = value.split(/[\s,;]+/).filter(Boolean).length;
  return (
    <div className={`${s.field} ${s.span3}`}>
      <label className={s.field}>
        <span className={s.label}>Reminder times</span>
        <input className={s.input} name="reminder_times" value={value} onChange={(event) => setValue(event.target.value)} placeholder="09:00, 09:45" />
        <span className={s.hint}>24-hour times, separated by commas, as many as you need ({count} now). Leave empty to track the report without reminding.</span>
      </label>
      <div className={s.intervalRow} role="group" aria-label="Fill reminder times at an interval">
        <span className={s.hint}>Or repeat:</span>
        <label>From <input className={s.input} type="time" value={start} onChange={(event) => setStart(event.target.value)} /></label>
        <label>to <input className={s.input} type="time" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
        <label>every <input className={s.input} type="number" min={1} max={720} value={every} onChange={(event) => setEvery(event.target.value)} style={{ width: 80 }} /> min</label>
        <button type="button" className={`${s.button} ${s.small}`} onClick={fill}><Repeat size={14} aria-hidden />Fill times</button>
      </div>
      {error ? <span className={s.hint} role="alert" style={{ color: "#b42318" }}>{error}</span> : null}
    </div>
  );
}
