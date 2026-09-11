"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { CpsParams } from "@/lib/ops-pulse/cps";
export function CpsFilters({
  params,
  period,
  places,
  today,
}: {
  params: CpsParams;
  period: { mode: string; date: string; month: string };
  today: string;
  places: { code: string; name: string; cluster: string; region: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <form
      className="cps-filters panel"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        const query = new URLSearchParams();
        new FormData(event.currentTarget).forEach((value, key) => {
          if (String(value)) query.set(key, String(value));
        });
        start(() => router.push(`/cps?${query.toString()}`, { scroll: false }));
      }}
    >
      <input type="hidden" name="view" value={params.view || "overview"} />
      <label>
        Period
        <select
          name="period"
          defaultValue={period.mode}
          disabled={["daily", "monthly", "mtd"].includes(params.view ?? "")}
        >
          <option value="daily">Day</option>
          <option value="mtd">MTD</option>
          <option value="monthly">Month</option>
        </select>
      </label>
      <label>
        Date / MTD through
        <input type="date" name="date" defaultValue={period.date} max={today} />
      </label>
      <label>
        Month
        <input
          type="month"
          name="month"
          defaultValue={period.month}
          max={today.slice(0, 7)}
        />
      </label>
      <label>
        Region
        <select name="region" defaultValue={params.region || ""}>
          <option value="">All permitted regions</option>
          {[...new Set(places.map((p) => p.region))].sort().map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <label>
        Cluster
        <select name="cluster" defaultValue={params.cluster || ""}>
          <option value="">All permitted clusters</option>
          {[...new Set(places.map((p) => p.cluster))].sort().map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <label>
        Location
        <select name="station" defaultValue={params.station || ""}>
          <option value="">All permitted locations</option>
          {places.map((p) => (
            <option key={p.code} value={p.code}>
              {p.code} · {p.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="button primary" disabled={pending}>
        {pending ? "Loading…" : "Apply"}
      </button>
      <button
        type="button"
        className="button"
        disabled={pending}
        onClick={() => start(() => router.refresh())}
      >
        Refresh
      </button>
      <span className="cps-filter-note">
        Day and MTD use the selected date. Month uses the selected calendar
        month.
      </span>
    </form>
  );
}
