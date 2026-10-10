"use client";
import { useState } from "react";
import type { AuditNotificationUser } from "@/lib/ops-pulse/station-audit-recipients";

export function AuditRecipientPicker({
  name,
  label,
  selected,
  users,
  roles,
}: {
  name: string;
  label: string;
  selected: string[];
  users: AuditNotificationUser[];
  roles: { id: string; name: string }[];
}) {
  const [values, setValues] = useState(selected);
  const [query, setQuery] = useState("");
  const options = [
    { value: "station_email", label: "Station mailbox" },
    {
      value: "people_reporting_chain",
      label: "People - station reporting chain and responsibilities",
    },
    { value: "company_owners", label: "Company owners" },
    {
      value: "cluster_manager_email",
      label: "People - current cluster manager",
    },
    {
      value: "ops_manager_email",
      label: "People - current area operations manager",
    },
    {
      value: "station_manager_email",
      label: "Station master - station manager mailbox",
    },
    {
      value: "finance_manager_email",
      label: "Station master - finance manager mailbox",
    },
    ...roles
      .filter((r) => users.some((u) => u.roleIds.includes(r.id)))
      .map((r) => ({ value: `role:${r.id}`, label: `Role: ${r.name}` })),
    ...users.map((u) => ({
      value: `user:${u.id}`,
      label: `${u.name} - ${u.email}`,
    })),
  ];
  const missing = values.filter(
    (value) => !options.some((option) => option.value === value),
  );
  const all = [
    ...options,
    ...missing.map((value) => ({
      value,
      label: `Unavailable recipient - remove if no longer required (${value})`,
    })),
  ];
  const visible = all.filter(
    (option) =>
      values.includes(option.value) ||
      option.label.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <fieldset
      style={{
        border: "1px solid #dbe3ee",
        borderRadius: 10,
        padding: 14,
        margin: "12px 0",
      }}
    >
      <legend style={{ fontWeight: 650 }}>{label}</legend>
      <input type="hidden" name={name} value={JSON.stringify(values)} />
      <p className="subtle">
        Select rules, roles or named stakeholders. Recipients must be active,
        have Audit access and be authorized for the station. People supplies the
        current reporting chain. Duplicate email addresses receive one copy.
      </p>
      <input
        aria-label={`Search ${label}`}
        placeholder="Search name, email or role"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        style={{ width: "100%", marginBottom: 10 }}
      />
      <div
        style={{ maxHeight: 230, overflow: "auto", display: "grid", gap: 8 }}
      >
        {visible.map((option) => (
          <label
            key={option.value}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={values.includes(option.value)}
              onChange={(event) =>
                setValues(
                  event.target.checked
                    ? [...values, option.value]
                    : values.filter((v) => v !== option.value),
                )
              }
            />
            {option.label}
          </label>
        ))}
      </div>
      <small>{values.length} recipient rules selected</small>
    </fieldset>
  );
}
