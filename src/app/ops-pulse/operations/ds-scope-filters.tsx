"use client";

import { EddMultiSelect } from "@/app/ops-pulse/edd/edd-multi-select";
import {
  changeDsScope,
  dsScopeOptions,
  type DsManagerOption,
  type DsScope,
  type DsStoreMeta
} from "@/lib/ops-pulse/ds-scope";

export function DsScopeFilters({
  stores,
  managers,
  value,
  onChange
}: {
  stores: DsStoreMeta[];
  managers: DsManagerOption[];
  value: DsScope;
  onChange: (next: DsScope) => void;
}) {
  const options = dsScopeOptions(stores, managers, value);
  const change = (key: keyof DsScope) => (next: Set<string>) =>
    onChange(changeDsScope(stores, managers, value, key, [...next]));

  return (
    <>
      <EddMultiSelect
        label="Region"
        options={options.regions}
        selected={new Set(value.regions)}
        onChange={change("regions")}
        renderOption={(id) => id}
      />
      <EddMultiSelect
        label="City / Regional manager"
        options={options.clusters.map((c) => c.value)}
        selected={new Set(value.clusters)}
        onChange={change("clusters")}
        renderOption={(id) => managers.find((m) => m.value === id)?.label || id}
      />
      <EddMultiSelect
        label="Store"
        options={options.stations}
        selected={new Set(value.stations)}
        onChange={change("stations")}
        renderOption={(code) => {
          const store = stores.find((s) => s.code === code);
          return store ? `${store.code} · ${store.name}` : code;
        }}
      />
    </>
  );
}
