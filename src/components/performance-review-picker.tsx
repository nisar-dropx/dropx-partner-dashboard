"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type ReviewLocation = {
  code: string;
  name: string;
};

export function PerformanceReviewPicker({
  date,
  locations,
  stationCode,
}: {
  date: string;
  locations: ReviewLocation[];
  stationCode: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selectedDate, setSelectedDate] = useState(date);
  const [selectedStation, setSelectedStation] = useState(stationCode);

  useEffect(() => {
    setSelectedDate(date);
    setSelectedStation(stationCode);
  }, [date, stationCode]);

  function open(nextDate: string, nextStation: string) {
    const params = new URLSearchParams({
      date: nextDate,
      review: nextStation,
      view: "reviews",
    });
    startTransition(() => router.push(`/ops-pulse/performance?${params.toString()}`));
  }

  return <div className="performance-review-picker" aria-busy={isPending}>
    <label>Performance date<input type="date" value={selectedDate} onChange={(event) => {
      const nextDate = event.target.value;
      setSelectedDate(nextDate);
      if (nextDate) open(nextDate, selectedStation);
    }}/></label>
    <label>Station<select value={selectedStation} onChange={(event) => {
      const nextStation = event.target.value;
      setSelectedStation(nextStation);
      open(selectedDate, nextStation);
    }}>{locations.map((location) => <option key={location.code} value={location.code}>{location.code} · {location.name}</option>)}</select></label>
    <button type="button" disabled={isPending} onClick={() => open(selectedDate, selectedStation)}>{isPending ? "Loading…" : "Refresh"}</button>
  </div>;
}
