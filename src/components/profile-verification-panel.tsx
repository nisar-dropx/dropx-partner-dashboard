"use client";

import { useEffect, useRef, useState } from "react";
import type { WorkforceProfileType } from "@/lib/workforce-profiles";

export type VerificationKind = "pan" | "pan_aadhaar" | "dl" | "vehicle" | "bank" | "pf_uan";

type VerificationResult = {
  kind: VerificationKind;
  inputKey?: string;
  verified?: boolean;
  manualReview?: boolean;
  blockSubmit?: boolean;
  nameMatchStatus?: "exact" | "partial" | "none";
  name?: string;
  accountName?: string;
  ownerName?: string;
  fuelType?: string;
  message?: string;
  warning?: string;
  expiryDate?: string;
  registrationExpiryDate?: string;
  insuranceExpiryDate?: string;
  pollutionExpiryDate?: string;
};

type ProfileVerificationPanelProps = {
  accountId: string;
  kind: VerificationKind;
  profileType: WorkforceProfileType;
  pageCode?: "employees" | "delivery_associates" | "contractors" | "vendors" | "workers";
};

const labels: Record<VerificationKind, string> = {
  pan: "PAN",
  pan_aadhaar: "PAN Aadhaar",
  dl: "DL",
  vehicle: "Vehicle",
  bank: "Bank",
  pf_uan: "PF UAN"
};

function text(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function inputKey(parts: string[]) {
  return parts.map((part) => part.trim().toUpperCase()).join("|");
}

function verificationDateKey(value: string) {
  const raw = value.trim();
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return `${isoMatch[3]}-${isoMatch[2]}-${isoMatch[1]}`;
  return raw.replace(/\//g, "-");
}

function comparableKey(target: VerificationKind, value?: string) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (target !== "dl") return raw;
  const [license = "", date = ""] = raw.split("|");
  const isoMatch = date.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  const localMatch = date.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  const normalizedDate = isoMatch
    ? `${isoMatch[1]}${isoMatch[2]}${isoMatch[3]}`
    : localMatch
      ? `${localMatch[3]}${localMatch[2]}${localMatch[1]}`
      : date.replace(/\D/g, "");
  return `${license}|${normalizedDate}`;
}

function keysMatch(target: VerificationKind, left?: string, right?: string) {
  return comparableKey(target, left) === comparableKey(target, right);
}

function displayDateToInput(value?: string) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!match) return raw;
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function resultMessage(result?: VerificationResult) {
  if (!result) return "";
  const parts = [];
  if (result.kind === "pan" && result.name) parts.push(`PAN name: ${result.name}`);
  if (result.kind === "dl" && result.name) parts.push(`DL name: ${result.name}`);
  if (result.kind === "vehicle" && result.ownerName) parts.push(`RC owner: ${result.ownerName}`);
  if (result.kind === "vehicle" && result.fuelType) parts.push(`Fuel type: ${result.fuelType}`);
  if (result.kind === "bank" && result.accountName) parts.push(`Bank name: ${result.accountName}`);
  if (result.kind === "pf_uan" && result.name) parts.push(`PF UAN name: ${result.name}`);
  let message = result.warning || result.message || "";
  if (result.kind === "pan" && result.name) {
    const normalized = message.toLowerCase();
    if (normalized.includes("pan verified") && normalized.includes("pan name")) message = "";
  }
  if (message) parts.push(message);
  return parts.join(" | ");
}

function panGroupMessage(pan?: VerificationResult, panAadhaar?: VerificationResult) {
  const parts = [];
  if (pan?.name) parts.push(`PAN name: ${pan.name}`);
  if (panAadhaar?.message) parts.push(panAadhaar.message);
  if (!panAadhaar?.message && panAadhaar?.verified) parts.push("PAN Aadhaar link verified.");
  if (!parts.length && pan?.message) parts.push(pan.message);
  return parts.join(" | ");
}

function isElectric(result?: VerificationResult) {
  const fuel = String(result?.fuelType ?? "").toLowerCase();
  return fuel.includes("electric") || fuel === "ev";
}

export function ProfileVerificationPanel({ accountId, kind, profileType, pageCode = "employees" }: ProfileVerificationPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const initialInputKeyRef = useRef("");
  const [results, setResults] = useState<Partial<Record<VerificationKind, VerificationResult>>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [isDirty, setIsDirty] = useState(false);

  function form() {
    return hostRef.current?.closest("form") ?? null;
  }

  function currentFields() {
    const currentForm = form();
    const data = new FormData(currentForm ?? undefined);
    return {
      fullName: text(data.get("full_name")),
      panNumber: text(data.get("pan_number")).toUpperCase(),
      aadhaarNumber: text(data.get("aadhaar_number")).replace(/\D/g, ""),
      dateOfBirth: text(data.get("date_of_birth")),
      drivingLicenseNo: text(data.get("driving_license_no")).toUpperCase(),
      vehicleRegNo: text(data.get("vehicle_reg_no")).toUpperCase(),
      bankAccountNo: text(data.get("bank_account_no")).replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
      ifsc: text(data.get("ifsc") ?? data.get("ifsc_code")).toUpperCase(),
      pfUan: text(data.get("pf_uan")).replace(/\D/g, "")
    };
  }

  function keyFor(target: VerificationKind, fields = currentFields()) {
    if (target === "pan") return inputKey([fields.panNumber]);
    if (target === "pan_aadhaar") return inputKey([fields.panNumber, fields.aadhaarNumber]);
    if (target === "dl") return inputKey([fields.drivingLicenseNo, verificationDateKey(fields.dateOfBirth)]);
    if (target === "vehicle") return inputKey([fields.vehicleRegNo]);
    if (target === "pf_uan") return inputKey([fields.pfUan]);
    return inputKey([fields.bankAccountNo, fields.ifsc]);
  }

  function editKey(fields = currentFields()) {
    return kind === "pan" ? keyFor("pan_aadhaar", fields) : keyFor(kind, fields);
  }

  function setFieldValue(name: string, value?: string) {
    const input = form()?.elements.namedItem(name) as HTMLInputElement | null;
    const next = displayDateToInput(value);
    if (input && next) {
      input.value = next;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function missingMessage(target = kind, fields = currentFields()) {
    if (target === "pan" && (!fields.panNumber || !fields.aadhaarNumber)) return "PAN and Aadhaar are required.";
    if (target === "pan_aadhaar" && (!fields.panNumber || !fields.aadhaarNumber)) return "PAN and Aadhaar are required.";
    if (target === "pan_aadhaar" && (!results.pan || results.pan.blockSubmit)) return "Verify PAN first.";
    if (target === "dl" && (!fields.drivingLicenseNo || !fields.dateOfBirth)) return "DL and DOB are required.";
    if (target === "vehicle" && !fields.vehicleRegNo) return "Vehicle number is required.";
    if (target === "bank" && (!fields.bankAccountNo || !fields.ifsc)) return "Bank account and IFSC are required.";
    if (target === "pf_uan" && !fields.pfUan) return "PF UAN is required.";
    return "";
  }

  async function runVerification(target: VerificationKind, fields = currentFields()) {
    const response = await fetch("/api/profile-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, profileType, pageCode, kind: target, ...fields })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Unable to verify.");
    return { ...body, kind: target } as VerificationResult;
  }

  async function verify() {
    const fields = currentFields();
    const missing = missingMessage(kind, fields);
    if (missing) {
      setError(missing);
      return;
    }
    setError("");
    setRunning(true);
    try {
      const result = await runVerification(kind, fields);
      if (kind === "dl") setFieldValue("driving_license_exp_date", result.expiryDate);
      if (kind === "vehicle") {
        setFieldValue("vehicle_reg_exp_date", result.registrationExpiryDate);
        setFieldValue("vehicle_insurance_exp_date", result.insuranceExpiryDate);
        setFieldValue("vehicle_pollution_exp_date", isElectric(result) ? "" : result.pollutionExpiryDate);
      }
      const next = { ...results, [kind]: result };
      if (kind === "pan") {
        delete next.pan_aadhaar;
        if (!result.blockSubmit) {
          const aadhaarMissing = !fields.panNumber || !fields.aadhaarNumber ? "PAN and Aadhaar are required." : "";
          if (aadhaarMissing) {
            setError(aadhaarMissing);
          } else {
            const aadhaarResult = await runVerification("pan_aadhaar", fields);
            next.pan_aadhaar = aadhaarResult;
            window.dispatchEvent(new CustomEvent("dropx-profile-verification", { detail: { kind: "pan_aadhaar", result: aadhaarResult } }));
          }
        }
      }
      setResults(next);
      initialInputKeyRef.current = editKey(fields);
      setIsDirty(false);
      window.dispatchEvent(new CustomEvent("dropx-profile-verification", { detail: { kind, result } }));
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "Unable to verify.");
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    let alive = true;
    fetch(`/api/profile-verification?accountId=${encodeURIComponent(accountId)}&profileType=${encodeURIComponent(profileType)}&pageCode=${encodeURIComponent(pageCode)}`)
      .then((response) => response.ok ? response.json() : { verifications: [] })
      .then((body) => {
        if (!alive) return;
        const next: Partial<Record<VerificationKind, VerificationResult>> = {};
        for (const row of body.verifications ?? []) {
          const details = row.details ?? {};
          next[row.kind as VerificationKind] = {
            ...details,
            kind: row.kind,
            inputKey: row.inputKey,
            verified: row.verified,
            manualReview: row.manualReview,
            blockSubmit: row.blockSubmit,
            name: row.name ?? details.name,
            message: row.message ?? ""
          };
        }
        setResults(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [accountId, pageCode, profileType]);

  useEffect(() => {
    const currentForm = form();
    if (!currentForm) return;
    initialInputKeyRef.current = editKey();
    setIsDirty(false);
    const reconcile = () => {
      setIsDirty(editKey() !== initialInputKeyRef.current);
      setResults((current) => {
        const fields = currentFields();
        const next = { ...current };
        if (next[kind]?.inputKey && !keysMatch(kind, next[kind]?.inputKey, keyFor(kind, fields))) delete next[kind];
        if (kind === "pan" && next.pan_aadhaar?.inputKey && next.pan_aadhaar.inputKey !== keyFor("pan_aadhaar", fields)) delete next.pan_aadhaar;
        if (kind === "pan_aadhaar" && next.pan?.inputKey && next.pan.inputKey !== keyFor("pan", fields)) delete next.pan;
        return next;
      });
    };
    currentForm.addEventListener("input", reconcile);
    currentForm.addEventListener("change", reconcile);
    const receive = (event: Event) => {
      const detail = (event as CustomEvent).detail as { kind?: VerificationKind; result?: VerificationResult };
      if (!detail?.kind || !detail.result) return;
      setResults((current) => ({ ...current, [detail.kind as VerificationKind]: detail.result }));
    };
    window.addEventListener("dropx-profile-verification", receive);
    return () => {
      currentForm.removeEventListener("input", reconcile);
      currentForm.removeEventListener("change", reconcile);
      window.removeEventListener("dropx-profile-verification", receive);
    };
  }, [kind]);

  const fields = currentFields();
  const storedResult = results[kind];
  const storedPanAadhaarResult = results.pan_aadhaar;
  const result = keysMatch(kind, storedResult?.inputKey, keyFor(kind, fields)) ? storedResult : undefined;
  const panAadhaarResult = storedPanAadhaarResult?.inputKey === keyFor("pan_aadhaar", fields) ? storedPanAadhaarResult : undefined;
  const isVerified = kind === "pan" ? Boolean(result?.verified && panAadhaarResult?.verified) : Boolean(result?.verified);
  const missing = missingMessage(kind, fields);
  const message = kind === "pan" ? panGroupMessage(result, panAadhaarResult) : resultMessage(result);
  const hiddenResults = kind === "pan" ? [result, panAadhaarResult].filter(Boolean) : [result].filter(Boolean);
  const resultTone = isVerified ? "ok" : result?.manualReview ? "warn" : result ? "error" : "";
  return (
    <div className={`profile-verification-inline ${resultTone} ${!isVerified && isDirty ? "needs-button" : ""}`} ref={hostRef}>
      {hiddenResults.length ? (
        <input name="profile_verification_results" type="hidden" value={JSON.stringify(hiddenResults)} />
      ) : null}
      {!isVerified && isDirty ? (
        <button className="button secondary profile-verification-button" disabled={running || Boolean(missing)} onClick={verify} type="button">
          {running ? "Verifying" : "Verify"}
        </button>
      ) : null}
      <span>{running ? `Verifying ${labels[kind]}...` : result ? message || "Checked." : missing || "Not verified"}</span>
      {error ? <span className="profile-verification-error">{error}</span> : null}
    </div>
  );
}
