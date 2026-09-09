"use client";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Search, RotateCcw } from "lucide-react";
import type { EddQuery, SortDirection } from "@/lib/ops-pulse/edd-table-controls";
import s from "./station-edd.module.css";

export function useEddQuery(initial: EddQuery) {
  const [query, setQuery] = useState(initial);
  useEffect(() => {
    const restore = () => setQuery(Object.fromEntries(new URLSearchParams(window.location.search)));
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  function update(patch: EddQuery, replace = false) {
    const next = Object.fromEntries(Object.entries(replace ? patch : { ...query, ...patch }).filter(([, value]) => value !== ""));
    setQuery(next);
    const params = new URLSearchParams(next).toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${params ? `?${params}` : ""}${window.location.hash}`);
  }
  return [query, update] as const;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className={s.field}><span>{label}</span>{children}</label>;
}
export function TableSearch({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <Field label={label}><span className={s.search}><Search size={16}/><input type="search" placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)}/></span></Field>;
}
export function SortHeader({ label, column, sort, direction, onSort, numeric = false }: { label: string; column: string; sort: string; direction: SortDirection; onSort: (column: string) => void; numeric?: boolean }) {
  const active = sort === column;
  return <th scope="col" className={numeric ? s.numeric : ""} aria-sort={active ? direction === "asc" ? "ascending" : "descending" : "none"}><button type="button" aria-label={`Sort by ${label}${active ? `, currently ${direction === "asc" ? "ascending" : "descending"}` : ""}`} onClick={() => onSort(column)}>{label}{active ? direction === "asc" ? <ArrowUp size={12}/> : <ArrowDown size={12}/> : <ArrowUpDown size={12}/>}</button></th>;
}
export function ResetFilters({ onClick, label = "Reset filters" }: { onClick: () => void; label?: string }) {
  return <button type="button" className={s.button} onClick={onClick}><RotateCcw size={14}/>{label}</button>;
}
export function TablePager({ count, page, size, onPage, onSize, noun }: { count: number; page: number; size: number; onPage: (page: number) => void; onSize: (size: string) => void; noun: string }) {
  const pages = Math.max(1, Math.ceil(count / size));
  const current = Math.min(page, pages);
  return <div className={s.pagination}><span role="status">{count ? `${(current - 1) * size + 1}–${Math.min(current * size, count)}` : "0"} of {count.toLocaleString("en-IN")} {noun}</span><div><label>Rows per page <select className={s.select} value={size} onChange={e => onSize(e.target.value)}>{[25, 50, 100].map(value => <option key={value} value={value}>{value}</option>)}</select></label><button className={s.button} disabled={current <= 1} onClick={() => onPage(current - 1)}>Previous</button><span>Page {current} of {pages}</span><button className={s.button} disabled={current >= pages} onClick={() => onPage(current + 1)}>Next</button></div></div>;
}
