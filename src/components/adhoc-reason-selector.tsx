"use client";
import { useEffect, useState } from "react";
import {
  adhocStatusLabel,
  adhocVehicleLabel,
  eligibleAdhocVehicles,
  isBreakdownVehicleReason,
  normalizeAdhocVehicleNo,
  requiredAdhocStatuses,
  usesAdhocVehicleDropdown,
  type AdhocContext,
} from "@/lib/adhoc-vehicle-policy";

type LookupOk = {
  ok: true;
  vehicle: { id: string; number: string; model: string; status: string };
  evidenceLabel: string;
};

export function AdhocReasonSelector({
  name,
  location,
  date,
  onChange,
}: {
  name: string;
  location: string;
  date: string;
  onChange: (value: string) => void;
}) {
  const [data, setData] = useState<AdhocContext | null>(null);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [retry, setRetry] = useState(0);
  const [plate, setPlate] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [verified, setVerified] = useState<LookupOk | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setReason("");
    onChange("");
    setError("");
    setPlate("");
    setLookupError("");
    setVerified(null);
    if (location && date) {
      fetch(`/api/payments/adhoc-context?${new URLSearchParams({ location, date })}`, {
        signal: controller.signal,
        cache: "no-store",
      })
        .then(async (r) => {
          const b = await r.json();
          if (!r.ok) throw new Error(b.error);
          setData(b);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        });
    }
    return () => controller.abort();
    // onChange only reports resets; changing its identity must not reload the selector.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, date, retry]);

  const rule = data?.rules.find((r) => r.label === reason);
  const vehicles = rule && data ? eligibleAdhocVehicles(rule, data.vehicles, date) : [];
  const breakdown = isBreakdownVehicleReason(rule);
  const showDropdown = usesAdhocVehicleDropdown(rule);

  async function verifyPlate() {
    setLookupError("");
    setVerified(null);
    const vehicleNo = normalizeAdhocVehicleNo(plate);
    if (!vehicleNo) {
      setLookupError("Enter the company vehicle number.");
      return;
    }
    setLookupBusy(true);
    try {
      const response = await fetch(
        `/api/payments/adhoc-vehicle-lookup?${new URLSearchParams({ location, date, vehicle_no: vehicleNo })}`,
        { cache: "no-store" }
      );
      const body = await response.json();
      if (!response.ok || !body.ok) {
        setLookupError(body.error || "Unable to verify vehicle.");
        return;
      }
      setVerified(body as LookupOk);
      setPlate(body.vehicle.number);
    } catch {
      setLookupError("Unable to verify vehicle. Please retry.");
    } finally {
      setLookupBusy(false);
    }
  }

  return (
    <span style={{ display: "grid", gap: 8 }}>
      <select
        className="field"
        name={name}
        required
        value={reason}
        onChange={(e) => {
          setReason(e.target.value);
          onChange(e.target.value);
          setPlate("");
          setLookupError("");
          setVerified(null);
        }}
      >
        <option value="">
          {!location || !date
            ? "Select station and date first"
            : !data
              ? "Loading vehicle checks…"
              : "Select reason"}
        </option>
        {data?.rules.map((r) => (
          <option key={r.reason_key} value={r.label}>
            {r.label}
          </option>
        ))}
      </select>
      {error ? (
        <span role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRetry(retry + 1)}>
            Retry
          </button>
        </span>
      ) : null}

      {showDropdown ? (
        <>
          <span>Vehicle being replaced *</span>
          <select
            className="field"
            key={`${reason}:${location}:${date}`}
            name="adhoc_vehicle_id"
            required
            defaultValue=""
          >
            <option value="">Select vehicle / partner</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {adhocVehicleLabel(v)}
              </option>
            ))}
          </select>
          {!vehicles.length ? (
            <small role="alert">
              {requiredAdhocStatuses(rule!).length
                ? `No eligible vehicles recorded as ${requiredAdhocStatuses(rule!)
                    .map(adhocStatusLabel)
                    .join(" or ")}. Request blocked.`
                : "No eligible vehicle available for this date."}{" "}
              Contact Fleet Manager{data?.contact ? " · " + data.contact : ""}.
            </small>
          ) : rule?.effect_status ? (
            <small>
              Records {rule.effect_status === "on_leave" ? "On Leave" : "Breakdown"} for {date}
              {rule.block_rent ? " · vehicle rent excluded for this day" : ""}.
            </small>
          ) : null}
        </>
      ) : null}

      {breakdown ? (
        <>
          <span>Company vehicle number *</span>
          <span style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              className="field"
              name="adhoc_vehicle_no"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. KL01AB1234"
              value={plate}
              onChange={(e) => {
                setPlate(e.target.value.toUpperCase());
                setVerified(null);
                setLookupError("");
              }}
              style={{ flex: "1 1 180px" }}
            />
            <button type="button" className="button secondary compact" disabled={lookupBusy || !location || !date} onClick={verifyPlate}>
              {lookupBusy ? "Checking…" : "Verify out on road"}
            </button>
          </span>
          <select
            name="adhoc_vehicle_id"
            required
            value={verified?.vehicle.id || ""}
            onChange={() => undefined}
            aria-label="Verified company vehicle"
            tabIndex={-1}
            style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0,0,0,0)", border: 0 }}
          >
            <option value="">Verify out on road first</option>
            {verified ? <option value={verified.vehicle.id}>{verified.vehicle.number}</option> : null}
          </select>
          {lookupError ? <small role="alert">{lookupError}</small> : null}
          {verified ? (
            <small>
              Verified {verified.vehicle.number}
              {verified.vehicle.model ? ` · ${verified.vehicle.model}` : ""} ·{" "}
              {adhocStatusLabel(verified.vehicle.status)} · {verified.evidenceLabel}. Records Breakdown for {date}.
            </small>
          ) : (
            <small>
              Enter the company van that broke down while out, then Verify. Allowed when Fleet location is In transit, GPS shows
              movement today, or Fleet status is already Breakdown / Under service
              {data?.contact ? ` · ${data.contact}` : ""}.
            </small>
          )}
        </>
      ) : null}
    </span>
  );
}
