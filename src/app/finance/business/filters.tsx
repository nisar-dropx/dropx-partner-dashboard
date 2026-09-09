"use client";
import Link from "next/link";
import { useState } from "react";
import { monthEnd, todayIndia, validMonth } from "@/lib/finance/pricing";
type Filters = {
  month: string;
  through: string;
  provider: string;
  region: string;
  cluster: string;
  location: string;
};
type Place = { code: string; name: string; region: string; cluster: string };
export function BusinessFilters({
  initial,
  locations,
  tab,
}: {
  initial: Filters;
  locations: Place[];
  tab: string;
}) {
  const [filters, setFilters] = useState(initial);
  const today = todayIndia();
  const regions = [...new Set(locations.map((l) => l.region))].sort();
  const clusters = [
    ...new Set(
      locations
        .filter((l) => !filters.region || l.region === filters.region)
        .map((l) => l.cluster),
    ),
  ].sort();
  const options = locations.filter(
    (l) =>
      (!filters.region || l.region === filters.region) &&
      (!filters.cluster || l.cluster === filters.cluster),
  );
  const setMonth = (month: string) => {
    if (!validMonth(month)) {
      setFilters({ ...filters, month, through: "" });
      return;
    }
    const end = monthEnd(month);
    setFilters({ ...filters, month, through: end < today ? end : today });
  };
  return (
    <form className="fin-filters" action="/finance/business">
      <input type="hidden" name="tab" value={tab} />
      <label>
        Billing month
        <input
          name="month"
          type="month"
          required
          max={today.slice(0, 7)}
          value={filters.month}
          onChange={(e) => setMonth(e.target.value)}
        />
      </label>
      <label>
        Through date
        <input
          name="through"
          type="date"
          required
          min={`${filters.month}-01`}
          max={
            validMonth(filters.month)
              ? monthEnd(filters.month) < today
                ? monthEnd(filters.month)
                : today
              : today
          }
          value={filters.through}
          onChange={(e) => setFilters({ ...filters, through: e.target.value })}
        />
      </label>
      <label>
        Client
        <select
          name="provider"
          value={filters.provider}
          onChange={(e) => setFilters({ ...filters, provider: e.target.value })}
        >
          <option value="">All clients</option>
          <option>Amazon</option>
          <option>Flipkart</option>
        </select>
      </label>
      <label>
        Region
        <select
          name="region"
          value={filters.region}
          onChange={(e) =>
            setFilters({
              ...filters,
              region: e.target.value,
              cluster: "",
              location: "",
            })
          }
        >
          <option value="">All regions</option>
          {regions.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <label>
        Cluster
        <select
          name="cluster"
          value={filters.cluster}
          onChange={(e) =>
            setFilters({ ...filters, cluster: e.target.value, location: "" })
          }
        >
          <option value="">All clusters</option>
          {clusters.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label>
        Location / allocation
        <select
          name="location"
          value={filters.location}
          onChange={(e) => setFilters({ ...filters, location: e.target.value })}
        >
          <option value="">All locations</option>
          {options.map((l) => (
            <option value={l.code} key={l.code}>
              {l.code} · {l.name}
            </option>
          ))}
        </select>
      </label>
      <button className="button" type="submit">
        Apply
      </button>
      <Link className="button secondary" href={`/finance/business?tab=${tab}`}>
        Reset
      </Link>
    </form>
  );
}
