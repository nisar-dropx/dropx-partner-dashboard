"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type ReviewLocation = {
  code: string;
  name: string;
  clusterKey?: string | null;
};

export function PerformanceReviewPicker({
  date,
  locations,
  stationCode,
  clusters = [],
  selectedCluster = "",
  canFilterClusters = false,
}: {
  date: string;
  locations: ReviewLocation[];
  stationCode: string;
  clusters?: { value: string; label: string }[];
  selectedCluster?: string;
  canFilterClusters?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selectedDate, setSelectedDate] = useState(date);
  const [selectedStation, setSelectedStation] = useState(stationCode);
  const [cluster, setCluster] = useState(selectedCluster);

  useEffect(() => {
    setSelectedDate(date);
    setSelectedStation(stationCode);
    setCluster(selectedCluster);
  }, [date, stationCode, selectedCluster]);

  const stationOptions = useMemo(() => {
    if (!cluster) return locations;
    return locations.filter((location) => (location.clusterKey || "") === cluster);
  }, [cluster, locations]);

  function open(nextDate: string, nextStation: string, nextCluster: string) {
    const params = new URLSearchParams({
      date: nextDate,
      review: nextStation,
      view: "reviews",
    });
    if (nextCluster) params.set("cluster", nextCluster);
    startTransition(() => router.push(`/performance?${params.toString()}`));
  }

  return <div className="performance-review-picker" aria-busy={isPending}>
    <label>Performance date<input type="date" value={selectedDate} onChange={(event) => {
      const nextDate = event.target.value;
      setSelectedDate(nextDate);
      if (nextDate) open(nextDate, selectedStation, cluster);
    }}/></label>
    {canFilterClusters && clusters.length ? <label>Cluster / AOM<select value={cluster} onChange={(event) => {
      const nextCluster = event.target.value;
      setCluster(nextCluster);
      const nextStations = nextCluster
        ? locations.filter((location) => (location.clusterKey || "") === nextCluster)
        : locations;
      const nextStation = nextStations.some((location) => location.code === selectedStation)
        ? selectedStation
        : (nextStations[0]?.code || selectedStation);
      setSelectedStation(nextStation);
      open(selectedDate, nextStation, nextCluster);
    }}>
      <option value="">All stations</option>
      {clusters.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select></label> : null}
    <label>Station<select value={selectedStation} onChange={(event) => {
      const nextStation = event.target.value;
      setSelectedStation(nextStation);
      open(selectedDate, nextStation, cluster);
    }}>{stationOptions.map((location) => <option key={location.code} value={location.code}>{location.code} · {location.name}</option>)}</select></label>
    <button type="button" disabled={isPending} onClick={() => open(selectedDate, selectedStation, cluster)}>{isPending ? "Loading…" : "Refresh"}</button>
  </div>;
}
