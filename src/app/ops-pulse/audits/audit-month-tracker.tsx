"use client";
import { Fragment, useState } from "react";
import type {
  StationAudit,
  StationAuditWorkspace,
  AuditStation,
} from "@/lib/ops-pulse/station-audits";
import {
  auditDay,
  auditLocalTime,
  auditResponseLabel,
  auditStatusLabel,
  auditTone,
  isFastAudit,
} from "@/lib/ops-pulse/station-audit-planning";
import { auditActor } from "./audit-detail";
import styles from "./audit-workspace.module.css";
export function AuditMonthTracker({
  workspace,
  stations,
  audits,
  onOpen,
}: {
  workspace: StationAuditWorkspace;
  stations: AuditStation[];
  audits: StationAudit[];
  onOpen: (audit: StationAudit) => void;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const types = workspace.auditTypes.filter((t) => t.is_active);
  return (
    <section className={styles.plan}>
      <div className={styles.calendarHead}>
        <div>
          <h2>Monthly team tracker</h2>
          <p>
            Completed fieldwork / required visits · expand a station for owners,
            responses, email status and reports.
          </p>
        </div>
      </div>
      <div className={styles.tableScroll}>
        <table className={styles.tracker}>
          <thead>
            <tr>
              <th>Station</th>
              {types.map((t) => (
                <th key={t.id}>
                  {t.code === "virtual_cod" ? "COD" : "Physical"} completed
                </th>
              ))}
              <th>Scheduled</th>
              <th>In progress</th>
              <th>Station response</th>
              <th>Needs review</th>
            </tr>
          </thead>
          <tbody>
            {stations.map((station) => {
              const rows = audits.filter((a) => a.location_id === station.id);
              const pending = rows.filter(
                (a) =>
                  a.station_response_status === "requested" && a.completed_at,
              );
              const replied = rows.filter((a) =>
                ["submitted", "accepted"].includes(a.station_response_status),
              );
              const failed = rows.filter((a) => a.email_status === "failed");
              const unlinked = rows.filter((a) => !a.assignment_verified);
              return (
                <Fragment key={station.id}>
                  <tr>
                    <th>
                      <button
                        className={styles.textButton}
                        aria-expanded={expanded.includes(station.id)}
                        onClick={() =>
                          setExpanded((v) =>
                            v.includes(station.id)
                              ? v.filter((id) => id !== station.id)
                              : [...v, station.id],
                          )
                        }
                      >
                        {expanded.includes(station.id) ? "▾" : "▸"}{" "}
                        {station.station_code}
                      </button>
                    </th>
                    {types.map((t) => (
                      <td key={t.id}>
                        <b>
                          {
                            rows.filter(
                              (a) => a.audit_type_id === t.id && a.completed_at,
                            ).length
                          }{" "}
                          / {t.required_count}
                        </b>
                      </td>
                    ))}
                    <td>
                      {rows.filter((a) => a.status_code === "scheduled").length}
                    </td>
                    <td>
                      {
                        rows.filter((a) => a.status_code === "in_progress")
                          .length
                      }
                    </td>
                    <td>
                      <span className={pending.length ? styles.fast : ""}>
                        {pending.length} pending
                      </span>{" "}
                      · {replied.length} responded
                    </td>
                    <td>
                      {failed.length ? `${failed.length} email failed · ` : ""}
                      {unlinked.length
                        ? `${unlinked.length} assignments to confirm`
                        : "—"}
                    </td>
                  </tr>
                  {expanded.includes(station.id) && (
                    <tr>
                      <td colSpan={types.length + 5}>
                        <div className={styles.list}>
                          {rows.length ? (
                            rows.map((a) => (
                              <button
                                key={a.id}
                                className={`${styles.auditCard} ${styles[auditTone(a) + "Border"]}`}
                                onClick={() => onOpen(a)}
                              >
                                <span>
                                  <b>{a.ops_audit_types?.name}</b>
                                  <small>
                                    {auditDay(a.scheduled_for)} ·{" "}
                                    {auditLocalTime(a.scheduled_for)} IST
                                  </small>
                                  <small>
                                    Assigned: {a.assigned_name || "Unassigned"}
                                    {!a.assignment_verified
                                      ? " · confirm user"
                                      : ""}
                                  </small>
                                  <small>
                                    Scheduled by:{" "}
                                    {auditActor(a, workspace, "scheduled")}
                                  </small>
                                </span>
                                <span>
                                  <b>{auditStatusLabel(a.status_code)}</b>
                                  <small>
                                    {a.completed_at
                                      ? `Completed by ${auditActor(a, workspace, "submitted")}`
                                      : a.started_at
                                        ? `Auditing: ${auditActor(a, workspace, "started")}`
                                        : "Not started"}
                                  </small>
                                  {isFastAudit(a) && (
                                    <small className={styles.fast}>
                                      ≤10 min · Quality check
                                    </small>
                                  )}
                                </span>
                                <span>
                                  <b>{auditResponseLabel(a)}</b>
                                  {["submitted", "accepted"].includes(
                                    a.station_response_status,
                                  ) && (
                                    <small>
                                      {auditActor(
                                        a,
                                        workspace,
                                        "station_responded",
                                      )}
                                    </small>
                                  )}
                                  <small>
                                    Email:{" "}
                                    {a.email_status === "sent"
                                      ? "Sent"
                                      : a.email_status === "failed"
                                        ? "Failed — retry in report"
                                        : a.completed_at
                                          ? "Not sent"
                                          : "After completion"}
                                  </small>
                                  <strong>
                                    {a.completed_at
                                      ? "View report →"
                                      : "Open audit →"}
                                  </strong>
                                </span>
                              </button>
                            ))
                          ) : (
                            <p className={styles.empty}>
                              No audits scheduled. Use Monthly plan to add the
                              required visits.
                            </p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
