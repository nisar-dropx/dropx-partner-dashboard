"use client";

import { useMemo, useState } from "react";
import {
  endAmazonTransporterAssignment,
  saveAmazonTransporterAssignment,
} from "@/app/ops-pulse/capacity/distance/map-amazon-id/actions";
import type { AmazonTransporterAssignment } from "@/lib/ops-pulse/amazon-transporter-assignments";
import styles from "./capacity-distance.module.css";

type Props = {
  workforceId: string;
  stationId: string;
  defaultFrom: string;
  defaultTo: string;
  driverIds: string[];
  assignments: AmazonTransporterAssignment[];
};

export function MapAmazonIdForm({
  workforceId,
  stationId,
  defaultFrom,
  defaultTo,
  driverIds,
  assignments,
}: Props) {
  const [transporterId, setTransporterId] = useState("");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [query, setQuery] = useState("");
  const [changeId, setChangeId] = useState("");
  const [pending, setPending] = useState(false);

  const filteredIds = useMemo(() => {
    const q = query.trim().toUpperCase();
    const list = driverIds.filter((id) => !q || id.includes(q));
    if (transporterId && !list.includes(transporterId)) return [transporterId, ...list];
    return list;
  }, [driverIds, query, transporterId]);

  function startChange(row: AmazonTransporterAssignment) {
    setChangeId(row.id);
    setTransporterId(row.transporter_id);
    setFrom(row.effective_from);
    setTo(row.effective_to || defaultTo);
    setPending(false);
  }

  return (
    <div className={styles.mapAmazonWrap}>
      <form
        action={async (formData) => {
          setPending(true);
          try {
            await saveAmazonTransporterAssignment(formData);
          } finally {
            setPending(false);
          }
        }}
        className={styles.mapAmazonForm}
      >
        <input type="hidden" name="workforce_id" value={workforceId} />
        <input type="hidden" name="station_id" value={stationId} />
        <input type="hidden" name="assignment_id" value={changeId} />

        <label className={styles.mapAmazonField}>
          Amazon driver ID
          <input
            name="transporter_id"
            value={transporterId}
            onChange={(e) => setTransporterId(e.target.value.toUpperCase())}
            placeholder="A…"
            autoComplete="off"
            required
            pattern="A[A-Za-z0-9]{5,31}"
            title="Amazon Flex driver ID starting with A"
          />
        </label>

        <div className={styles.mapAmazonDates}>
          <label className={styles.mapAmazonField}>
            From
            <input
              type="date"
              name="effective_from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              required
            />
          </label>
          <label className={styles.mapAmazonField}>
            To
            <input
              type="date"
              name="effective_to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
            />
          </label>
        </div>

        <div className={styles.mapAmazonPicker}>
          <div className={styles.mapAmazonPickerHead}>
            <strong>IDs at this station</strong>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search driver ID"
              aria-label="Search station Amazon driver IDs"
            />
          </div>
          <ul className={styles.mapAmazonIdList}>
            {filteredIds.map((id) => (
              <li key={id}>
                <button
                  type="button"
                  className={id === transporterId ? styles.mapAmazonIdActive : undefined}
                  onClick={() => setTransporterId(id)}
                >
                  {id}
                </button>
              </li>
            ))}
            {!filteredIds.length ? (
              <li className={styles.mapAmazonEmpty}>
                No station IDs loaded — type the Amazon driver ID above.
              </li>
            ) : null}
          </ul>
        </div>

        <div className={styles.mapAmazonActions}>
          <button className="button" type="submit" disabled={pending}>
            {pending ? "Saving…" : changeId ? "Update mapping" : "Apply"}
          </button>
          {changeId ? (
            <button
              type="button"
              className={styles.reset}
              onClick={() => {
                setChangeId("");
                setTransporterId("");
                setFrom(defaultFrom);
                setTo(defaultTo);
              }}
            >
              Cancel change
            </button>
          ) : null}
        </div>
      </form>

      <section className={styles.mapAmazonHistory} aria-label="Current assignments">
        <header>
          <h2>Current mappings</h2>
          <p>Change only the Amazon driver ID and dates for handoffs.</p>
        </header>
        {!assignments.length ? (
          <p className={styles.note}>No dated Amazon driver mappings for this associate at this station yet.</p>
        ) : (
          <ul className={styles.mapAmazonAssignmentList}>
            {assignments.map((row) => (
              <li key={row.id}>
                <div>
                  <strong>{row.transporter_id}</strong>
                  <span>
                    {row.effective_from} → {row.effective_to || "open"}
                  </span>
                </div>
                <div className={styles.mapAmazonRowActions}>
                  <button type="button" className={styles.open} onClick={() => startChange(row)}>
                    Change
                  </button>
                  <form action={endAmazonTransporterAssignment}>
                    <input type="hidden" name="assignment_id" value={row.id} />
                    <input type="hidden" name="workforce_id" value={workforceId} />
                    <input type="hidden" name="station_id" value={stationId} />
                    <input type="hidden" name="from" value={defaultFrom} />
                    <input type="hidden" name="to" value={defaultTo} />
                    <input type="hidden" name="end_on" value={defaultTo} />
                    <button type="submit" className={styles.reset}>
                      End on {defaultTo}
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
