import styles from "./worked-id-review.module.css";

export function WorkedIdBulkPeriods({
  periods,
  month,
}: {
  periods: any[];
  month: string;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Associate / period</th>
            <th>Station</th>
            <th>Bulk attendance</th>
            <th>Mapped-ID delivery days</th>
            <th>Days to review</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => (
            <tr key={p.id}>
              <td>
                <strong>{p.name}</strong>
                <small className={styles.sub}>{p.dropxId}</small>
                <small className={styles.sub}>
                  {p.effective_from} – {p.effective_to}
                </small>
              </td>
              <td>{p.stationCode}</td>
              <td>
                <strong>
                  {p.quantity} {p.attendance_basis}
                </strong>
                <small className={styles.sub}>Bulk upload · period total</small>
                <small className={styles.sub}>
                  {p.biometricDates.length} biometric days · not added again
                </small>
              </td>
              <td>
                <strong>{p.deliveryDates.length} days</strong>
                <small className={styles.sub}>
                  Distinct dates across mapped IDs
                </small>
              </td>
              <td>
                <strong className={p.needsReview ? styles.error : styles.punch}>
                  {p.gap === null ? "—" : p.gap}
                </strong>
                <small className={styles.sub}>{p.status}</small>
              </td>
              <td>
                <details className={styles.payDetails}>
                  <summary>View details</summary>
                  <p>
                    {p.comparable
                      ? `${p.quantity} bulk attendance days − ${p.deliveryDates.length} mapped-ID delivery days = ${p.gap} days to review (minimum 0).`
                      : "Uploaded hours cannot be converted into delivery days."}
                  </p>
                  <p>
                    This is a period comparison. It does not identify absent
                    dates, confirm who delivered, or change pay. Several IDs on
                    one date count once.
                  </p>
                  <p>
                    <strong>Mapped IDs:</strong>{" "}
                    {p.providerIds.join(", ") || "No own ID mapped"}
                  </p>
                  <p>
                    <strong>Delivery dates:</strong>{" "}
                    {p.deliveryDates.join(", ") || "None recorded"}
                  </p>
                  <p>
                    <strong>Biometric dates:</strong>{" "}
                    {p.biometricDates.join(", ") || "None recorded"}
                  </p>
                  {!!p.deliveries.length && (
                    <details>
                      <summary>ID / name / day evidence</summary>
                      <ul>
                        {p.deliveries
                          .filter((d: any) => d.count > 0)
                          .map((d: any, i: number) => (
                            <li key={i}>
                              {d.date} · {d.providerId} ·{" "}
                              {d.name || "Name unavailable"} · {d.count}{" "}
                              deliveries
                            </li>
                          ))}
                      </ul>
                    </details>
                  )}
                  {!!p.missingReportDates.length && (
                    <p className={styles.warning}>
                      Station report missing on {p.missingReportDates.length}{" "}
                      dates: {p.missingReportDates.join(", ")}. Check imports
                      before treating missing deliveries as no work.
                    </p>
                  )}
                  {p.ongoing && (
                    <p className={styles.warning}>
                      The period has not ended. This comparison is provisional.
                    </p>
                  )}
                  <p>
                    <strong>Source:</strong>{" "}
                    {p.file || "Saved bulk attendance input"}
                    {p.sourceRow ? ` · Excel row ${p.sourceRow}` : ""}
                  </p>
                  <p>
                    Salary is calculated from the uploaded period total and
                    posted on {p.effective_to}; the total is not assigned to
                    individual worked dates.
                  </p>
                  <a
                    href={`/payments/workforce-payouts?month=${month}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open workforce payouts / correct bulk input
                  </a>
                </details>
              </td>
            </tr>
          ))}
          {!periods.length && (
            <tr>
              <td colSpan={6}>No bulk periods match these filters.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
