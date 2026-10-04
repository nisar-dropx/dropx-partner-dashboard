"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { selectedCpsStations, type CpsParams } from "@/lib/ops-pulse/cps";
export function CpsFilters({
  params,
  period,
  places,
  today,
}: {
  params: CpsParams;
  period: { mode: string; date: string; month: string };
  today: string;
  places: { code: string; name: string; region: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mode,setMode]=useState(period.mode);
  const [search,setSearch]=useState('');
  const [stations,setStations]=useState(()=>selectedCpsStations(params.station));
  return (<>
    <div className="cps-quick-periods">{[{label:"MTD",period:"mtd",month:""},{label:"Last month",period:"monthly",month:new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7))-1,0)).toISOString().slice(0,7)}].map(p=><button key={p.label} type="button" disabled={pending} onClick={()=>{const q=new URLSearchParams(params as Record<string,string>);q.set("view","overview");q.set("period",p.period);q.delete("date");if(p.month)q.set("month",p.month);else q.delete("month");start(()=>router.push(`/cps?${q}`,{scroll:false}));}}>{p.label}</button>)}</div>
    <form
      className="cps-filters panel"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        const query = new URLSearchParams();
        new FormData(event.currentTarget).forEach((value, key) => {
          if (String(value)) query.set(key, String(value));
        });
        start(() => {
          router.push(`/cps?${query.toString()}`, { scroll: false });

        });
      }}
    >
      <input type="hidden" name="view" value={params.view || "overview"} />
      <label>
        Period
        <select
          name="period"
          value={mode}
          onChange={e=>setMode(e.target.value)}
          disabled={["daily", "monthly", "mtd"].includes(params.view ?? "")}
        >
          <option value="daily">Day</option>
          <option value="mtd">MTD</option>
          <option value="monthly">Month</option>
        </select>
      </label>
      {mode!=="monthly"&&<label>
        Date / MTD through
        <input type="date" name="date" defaultValue={period.date} max={today} />
      </label>}
      {mode==="monthly"&&<label>
        Month
        <input
          type="month"
          name="month"
          defaultValue={period.month}
          max={today.slice(0, 7)}
        />
      </label>}
      <label>
        Region
        <select name="region" defaultValue={params.region || ""}>
          <option value="">All permitted regions</option>
          {[...new Set(places.map((p) => p.region))].sort().map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <div className="cps-station-picker"><span>Stations</span><input type="hidden" name="station" value={stations.join(',')}/>
        <details><summary>{stations.length?`${stations.length} station${stations.length===1?'':'s'} selected`:'All permitted stations'}</summary><div className="cps-station-menu">
          <input aria-label="Find stations" placeholder="Search code or name…" value={search} onChange={e=>setSearch(e.target.value)}/>
          <div className="cps-picker-actions"><button type="button" onClick={()=>setStations([])}>All stations</button><button type="button" onClick={()=>setStations([...new Set([...stations,...places.filter(p=>`${p.code} ${p.name}`.toLowerCase().includes(search.toLowerCase())).map(p=>p.code)])])}>Select search results</button></div>
          <div className="cps-station-options">{places.filter(p=>`${p.code} ${p.name}`.toLowerCase().includes(search.toLowerCase())).map(p=><label key={p.code}><input type="checkbox" checked={stations.includes(p.code)} onChange={e=>setStations(e.target.checked?[...stations,p.code]:stations.filter(c=>c!==p.code))}/><span><strong>{p.code}</strong> · {p.name}</span></label>)}</div>
          <small>Choose one or more, then apply filters.</small>
        </div></details>
      </div>
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
    </form></>
  );
}
