"use client";
import { useState } from "react";
import type { AuditOption } from "@/lib/ops-pulse/station-audits";
import { saveAuditAirways } from "./actions";
import styles from "../../audits/audit-workspace.module.css";
export function AirwaysMaster({
  options,
  stations,
  canEdit,
}: {
  options: AuditOption[];
  stations: { id: string; station_code: string; station_name: string | null }[];
  canEdit: boolean;
}) {
  const airways = options.filter((option) => option.option_group === "airways");
  const [selected, setSelected] = useState(canEdit ? "" : airways[0]?.id || "");
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const entry = airways.find((option) => option.id === selected);
  return (
    <details className="panel" style={{ marginBottom: 16 }}>
      <summary className="panel-head">
        <div>
          <strong>Airways · station mappings</strong>
          <p className="subtle">
            Maintain the separate Airways filter used in the audit workspace.
            Unmapped stations are shown as Unassigned.
          </p>
        </div>
      </summary>
      <div className="panel-body">
        <label className={styles.inputLabel}>
          Airways
          <select
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value);
              setNotice("");
            }}
          >
            {canEdit && <option value="">+ Add Airways</option>}
            {airways.map((option) => (
              <option value={option.id} key={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <form
          key={selected}
          onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            setPending(true);
            try {
              const result = await saveAuditAirways(data);
              setNotice(result.message);
            } catch {
              setNotice("Unable to save Airways. Please try again.");
            } finally {
              setPending(false);
            }
          }}
        >
          <fieldset
            disabled={!canEdit || pending}
            style={{ border: 0, padding: 0 }}
          >
            <input name="id" type="hidden" value={selected} />
            <label className={styles.inputLabel} style={{ margin: "12px 0" }}>
              Airways name
              <input
                name="label"
                defaultValue={entry?.label || ""}
                maxLength={80}
                required
              />
            </label>
            <label className={styles.inputLabel}>
              Search stations
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Station code or name"
              />
            </label>
            <div className={styles.airwaysStations}>
              {stations.map((station) => (
                <label
                  key={station.id}
                  style={{
                    display: `${station.station_code} ${station.station_name}`
                      .toLowerCase()
                      .includes(search.toLowerCase())
                      ? "flex"
                      : "none",
                  }}
                >
                  <input
                    name="station_ids"
                    value={station.id}
                    type="checkbox"
                    defaultChecked={
                      Array.isArray(entry?.metadata.station_ids) &&
                      entry.metadata.station_ids.includes(station.id)
                    }
                  />
                  {station.station_code} · {station.station_name}
                </label>
              ))}
            </div>
            <button className="button compact" disabled={pending || !canEdit}>
              {pending ? "Saving…" : "Save Airways mapping"}
            </button>
          </fieldset>
          <p role="status">{notice}</p>
        </form>
      </div>
    </details>
  );
}
