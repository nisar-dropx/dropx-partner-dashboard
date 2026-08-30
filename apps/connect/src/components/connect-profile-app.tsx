"use client";

import {
  BadgeCheck, BriefcaseBusiness, CalendarDays, ChevronRight, CircleX, DoorOpen, Download, Fingerprint,
  ImagePlus, Mail, MapPin, Phone, ShieldCheck, TriangleAlert, UserRound, WalletCards
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { minimumAgeError } from "../lib/profile-age";
import { ConnectExitManagement } from "./connect-exit-management";
import { VerifiedProfilePhotoUpdate } from "./verified-profile-photo-update";

export type AppAccount = {
  id: string;
  companyId: string;
  profileType: string;
  companyName: string;
  name: string | null;
  email: string | null;
  reference: string | null;
  role: string | null;
  status?: string | null;
  biometricId?: string | null;
  profilePhotoUrl?: string | null;
  pageAccess?: string[];
  isDefault?: boolean;
  workspace?: "people" | "workforce";
  workspaceLabel?: string;
};

type Profile = {
  readOnly: Record<string, string>;
  editable: Record<string, string>;
  designationCode?: string;
  statutoryApplicability: string[];
  fieldRules?: { enabled?: string[]; required?: string[] };
  uploads: Record<string, boolean>;
  uploadUrls: Record<string, string>;
  profilePhotoUrl?: string;
  status: string;
  returnRemarks?: string;
  agreement?: {
    id: string;
    code: string;
    title: string;
    version: number;
    body: string;
    acceptedAt?: string | null;
  } | null;
};

type Verification = {
  kind: string;
  inputKey: string;
  verified: boolean;
  manualReview?: boolean;
  blockSubmit?: boolean;
  nameMatchStatus?: "exact" | "partial" | "none";
  name?: string;
  accountName?: string;
  ownerName?: string;
  fuelType?: string;
  message?: string;
  expiryDate?: string;
  registrationExpiryDate?: string;
  insuranceExpiryDate?: string;
  pollutionExpiryDate?: string;
};

type ProfileDraft = {
  data: Record<string, string>;
  verificationResults: Verification[];
  uploads: Record<string, boolean>;
  uploadUrls: Record<string, string>;
  updatedAt: string;
};

const bloodGroups = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const states = ["AN","AP","AR","AS","BR","CG","CH","DD","DL","DN","GA","GJ","HP","HR","JH","JK","KA","KL","LA","LD","MH","ML","MN","MP","MZ","NL","OD","PB","PY","RJ","SK","TN","TR","TS","UK","UP","WB"];
const relations = ["Parent", "Spouse", "Child", "Other Relative", "Friend", "Other"];
const defaultWorkforceFields = ["gender","date_of_birth","aadhaar_number","pan_number","eshram_uan","father_name","blood_group","is_handicapped","address","state_code","pincode","landmark","bank_account_no","ifsc","pf_uan","pf_account_no","esi_no","driving_license_no","driving_license_exp_date","vehicle_reg_no","vehicle_reg_exp_date","vehicle_insurance_exp_date","vehicle_pollution_exp_date","emergency_contact_number","emergency_contact_name","emergency_contact_relation","aadhaar_front","aadhaar_back","pan_upload","dl_front","dl_back","profile_photo"];
const defaultEmployee = defaultWorkforceFields;
const defaultExecutive = defaultWorkforceFields;
const fieldValueKeys: Record<string, string> = {
  date_of_birth: "dateOfBirth",
  aadhaar_number: "aadhaarNumber",
  pan_number: "panNumber",
  eshram_uan: "eshramUan",
  father_name: "fatherName",
  blood_group: "bloodGroup",
  is_handicapped: "isHandicapped",
  state_code: "stateCode",
  bank_account_no: "bankAccountNo",
  pf_uan: "pfUan",
  pf_account_no: "pfAccountNo",
  esi_no: "esiNo",
  emergency_contact_number: "emergencyContactNumber",
  emergency_contact_name: "emergencyContactName",
  emergency_contact_relation: "emergencyContactRelation",
  driving_license_no: "drivingLicenseNo",
  driving_license_exp_date: "drivingLicenseExpiry",
  vehicle_reg_no: "vehicleRegistrationNo",
  vehicle_reg_exp_date: "registrationExpiry",
  vehicle_insurance_exp_date: "insuranceExpiry",
  vehicle_pollution_exp_date: "pollutionExpiry"
};
const draftUploadSlots: Record<string, string> = {
  aadhaar_front: "aadhaarFront",
  aadhaar_back: "aadhaarBack",
  pan_upload: "pan",
  dl_front: "dlFront",
  dl_back: "dlBack",
  profile_photo: "photo"
};

const profileInputRules: Record<string, {
  pattern: RegExp;
  message: string;
  maxLength: number;
  numeric?: boolean;
  uppercase?: boolean;
}> = {
  pan_number: { pattern: /^[A-Z0-9]{10}$/, message: "PAN must contain exactly 10 letters or digits.", maxLength: 10, uppercase: true },
  aadhaar_number: { pattern: /^\d{12}$/, message: "Aadhaar number must contain exactly 12 digits.", maxLength: 12, numeric: true },
  pf_uan: { pattern: /^\d{12}$/, message: "PF UAN must contain exactly 12 digits.", maxLength: 12, numeric: true },
  eshram_uan: { pattern: /^\d{12}$/, message: "eShram UAN must contain exactly 12 digits.", maxLength: 12, numeric: true },
  pincode: { pattern: /^\d{6}$/, message: "Pincode must contain exactly 6 digits.", maxLength: 6, numeric: true },
  bank_account_no: { pattern: /^[A-Z0-9]{4,30}$/, message: "Bank account number must contain 4 to 30 letters or digits.", maxLength: 30, uppercase: true },
  ifsc: { pattern: /^[A-Z0-9]{11}$/, message: "IFSC must contain exactly 11 letters or digits.", maxLength: 11, uppercase: true },
  driving_license_no: { pattern: /^[A-Z0-9]{4,30}$/, message: "Driving license number must contain 4 to 30 letters or digits.", maxLength: 30, uppercase: true },
  vehicle_reg_no: { pattern: /^[A-Z0-9]{4,30}$/, message: "Vehicle registration number must contain 4 to 30 letters or digits.", maxLength: 30, uppercase: true },
  emergency_contact_number: { pattern: /^\d{4,30}$/, message: "Emergency contact number must contain 4 to 30 digits.", maxLength: 30, numeric: true }
};

function sanitizeProfileInput(field: string, value: string) {
  const rule = profileInputRules[field];
  if (!rule) return value;
  const filtered = rule.numeric ? value.replace(/\D/g, "") : value.replace(/[^a-zA-Z0-9]/g, "");
  const limited = filtered.slice(0, rule.maxLength);
  return rule.uppercase ? limited.toUpperCase() : limited;
}

function profileInputError(field: string, value: string) {
  const rule = profileInputRules[field];
  if (!rule || !value) return "";
  return rule.pattern.test(value) ? "" : rule.message;
}

function verificationInputError(kind: string, values: Record<string, string>) {
  if (kind === "pan" && values.panNumber && !profileInputRules.pan_number.pattern.test(values.panNumber)) {
    return "Invalid PAN.";
  }
  if (kind === "pan_aadhaar" && values.aadhaarNumber && !profileInputRules.aadhaar_number.pattern.test(values.aadhaarNumber)) {
    return "Invalid Aadhaar number.";
  }
  if (kind === "bank") {
    if (values.bankAccountNo && !profileInputRules.bank_account_no.pattern.test(values.bankAccountNo)) {
      return "Invalid bank account number.";
    }
    if (values.ifsc && !profileInputRules.ifsc.pattern.test(values.ifsc)) {
      return "Invalid IFSC.";
    }
  }
  if (kind === "pf_uan" && values.pfUan && !profileInputRules.pf_uan.pattern.test(values.pfUan)) {
    return "Invalid PF UAN.";
  }
  if (kind === "dl") {
    if (values.drivingLicenseNo && !profileInputRules.driving_license_no.pattern.test(values.drivingLicenseNo)) {
      return "Invalid DL No.";
    }
    if (values.dateOfBirth && !/^\d{2}\/\d{2}\/\d{4}$/.test(displayDate(values.dateOfBirth))) {
      return "Invalid date of birth.";
    }
  }
  if (kind === "vehicle" && values.vehicleRegistrationNo && !profileInputRules.vehicle_reg_no.pattern.test(values.vehicleRegistrationNo)) {
    return "Invalid vehicle number.";
  }
  return "";
}

function draftEditableValues(data: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => key !== "has_pf_uan" && key !== "has_esi_no")
      .map(([key, value]) => [
        fieldValueKeys[key] ?? key.replace(/_([a-z])/g, (_, character) => character.toUpperCase()),
        value
      ])
  );
}

function Spinner({ label = "Loading profile..." }: { label?: string }) {
  return <div className="dx-loader"><span /><small>{label}</small></div>;
}

function title(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function profileStatusLabel(profileStatus?: string | null, accountStatus?: string | null) {
  const raw = profileStatus?.trim() || accountStatus?.trim() || "active";
  return title(raw.toLowerCase());
}

function displayDate(value = "") {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : value;
}

function isoDate(value = "") {
  const local = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return local ? `${local[3]}-${local[2]}-${local[1]}` : value;
}

function formatDateTyping(value: string, appendSeparator = true) {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}${appendSeparator && digits.length === 4 ? "/" : ""}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

function statusReadOnly(value?: string | null) {
  return !["pending", "returned"].includes(String(value ?? "pending").trim().toLowerCase());
}

function expired(value?: string) {
  const match = String(value ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return false;
  const end = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]), 23, 59, 59);
  return end.getTime() < Date.now();
}

function VerifyField({ label, name, value, onChange, onVerify, running, checked, verified, disabled, placeholder, error, required }: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  onVerify?: () => void;
  running?: boolean;
  checked?: boolean;
  verified?: boolean;
  disabled?: boolean;
  placeholder?: string;
  error?: string;
  required?: boolean;
}) {
  const verificationCompleted = checked ?? verified;
  const rule = profileInputRules[name];
  const invalid = Boolean(rule && !rule.pattern.test(value));
  return <label className="dx-field">
    <span>{label}</span>
    <div className={`dx-input-action${disabled && placeholder ? " dx-verify-disabled" : ""}`}>
      <input
        disabled={disabled}
        inputMode={rule?.numeric ? "numeric" : "text"}
        maxLength={rule?.maxLength}
        name={name}
        onChange={(event) => onChange(sanitizeProfileInput(name, event.target.value))}
        placeholder={placeholder}
        required={required}
        value={value}
      />
      {onVerify && !verificationCompleted ? <button disabled={disabled || running || invalid} onClick={onVerify} type="button">{running ? <i className="mini-spin" /> : "Verify"}</button> : null}
      {verified ? <BadgeCheck className="dx-verified-icon" /> : null}
    </div>
    {error ? <small className="dx-field-error">{error}</small> : null}
  </label>;
}

function ManualDateField({ label, name, value, required, readOnly, warning, onChange }: {
  label: string;
  name: string;
  value: string;
  required?: boolean;
  readOnly?: boolean;
  warning?: string;
  onChange: (value: string) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  return <label className="dx-field dx-date-field">
    <span>{label}{required ? " *" : ""}</span>
    <div className="dx-date-input">
      <input
        inputMode="numeric"
        maxLength={10}
        name={name}
        onChange={(event) => {
          const raw = event.target.value;
          const deleting = raw.length < displayDate(value).length;
          const digits = raw.replace(/\D/g, "");
          if (!deleting && digits.length === 2) {
            onChange(`${digits}/`);
            return;
          }
          onChange(formatDateTyping(raw, !deleting));
        }}
        placeholder="dd/mm/yyyy"
        readOnly={readOnly}
        required={required}
        value={displayDate(value)}
      />
      {!readOnly ? <button aria-label={`Choose ${label}`} onClick={() => picker.current?.showPicker()} type="button"><CalendarDays /></button> : null}
      <input
        aria-hidden="true"
        className="dx-native-date"
        onChange={(event) => onChange(displayDate(event.target.value))}
        ref={picker}
        tabIndex={-1}
        type="date"
        value={isoDate(value)}
      />
    </div>
    {warning ? <small className="dx-expiry-warning">{warning}</small> : null}
  </label>;
}

function ReadTile({ label, value, verified, url, full }: { label: string; value?: string; verified?: boolean; url?: string; full?: boolean }) {
  const Icon = label.match(/mail/i) ? Mail : label.match(/mobile|contact/i) ? Phone : label.match(/date/i) ? CalendarDays : label.match(/location|state|pin|landmark/i) ? MapPin : label.match(/designation/i) ? BriefcaseBusiness : label.match(/bank|ifsc/i) ? WalletCards : label.match(/biometric/i) ? Fingerprint : UserRound;
  return <a className={`dx-profile-tile ${full ? "full" : ""} ${url ? "clickable" : ""}`} href={url || undefined} rel="noreferrer" target={url ? "_blank" : undefined}>
    <i><Icon /></i><div><span>{label}{verified ? <em><BadgeCheck />Verified</em> : null}</span><strong>{value || "-"}</strong></div>{url ? <Download className="download" /> : null}
  </a>;
}

export function ConnectProfileApp({ account, onPhoto, onSubmitted }: { account: AppAccount; onPhoto?: (url: string) => void; onSubmitted?: () => Promise<void> | void }) {
  const executive = account.profileType !== "employee" && account.profileType !== "user";
  const endpoint = executive ? "/api/connect/field-executive-profile" : "/api/connect/profile";
  const query = executive
    ? `executiveId=${account.id}&profileType=${encodeURIComponent(account.profileType)}`
    : `employeeId=${account.id}`;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [verifications, setVerifications] = useState<Record<string, Verification>>({});
  const [verificationErrors, setVerificationErrors] = useState<Record<string, string>>({});
  const [pfAnswer, setPfAnswer] = useState("");
  const [esiAnswer, setEsiAnswer] = useState("");
  const [running, setRunning] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [draftSaving, setDraftSaving] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [agreementAccepted, setAgreementAccepted] = useState(false);
  const [agreementGatePassed, setAgreementGatePassed] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    Promise.all([
      fetch(`${endpoint}?${query}`).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error);
        return payload.profile as Profile;
      }),
      fetch(`/api/connect/verification?accountId=${account.id}&profileType=${account.profileType}`).then((response) => response.json()),
      fetch(`/api/connect/profile-draft?accountId=${account.id}&profileType=${account.profileType}`).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to load draft.");
        return (payload.draft ?? null) as ProfileDraft | null;
      })
    ]).then(([nextProfile, checks, draft]) => {
      const next = nextProfile as Profile;
      const uploads = { ...next.uploads };
      const uploadUrls = { ...next.uploadUrls };
      if (draft) {
        Object.entries(draftUploadSlots).forEach(([draftSlot, profileSlot]) => {
          if (draft.uploads?.[draftSlot]) uploads[profileSlot] = true;
          if (draft.uploadUrls?.[draftSlot]) uploadUrls[profileSlot] = draft.uploadUrls[draftSlot];
        });
      }
      const editable = { ...(next.editable ?? {}), ...(draft ? draftEditableValues(draft.data) : {}) };
      const draftChecks = draft?.verificationResults?.length ? draft.verificationResults : null;
      setProfile({ ...next, uploads, uploadUrls });
      const agreementAlreadyAccepted = Boolean(next.agreement?.acceptedAt);
      setAgreementAccepted(agreementAlreadyAccepted);
      setAgreementGatePassed(agreementAlreadyAccepted);
      setValues(editable);
      setPfAnswer(draft?.data?.has_pf_uan ?? (editable.pfUan ? "yes" : ""));
      setEsiAnswer(draft?.data?.has_esi_no ?? (editable.esiNo ? "yes" : ""));
      setVerifications(Object.fromEntries((draftChecks ?? checks.verifications ?? []).map((item: Verification) => [item.kind, item])));
      if (draft) setNotice("Draft restored.");
      if (next.profilePhotoUrl) onPhoto?.(next.profilePhotoUrl);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to load profile."));
  }, [account.id, account.profileType, endpoint, query]);

  const enabled = useMemo(() => {
    const configured = profile?.fieldRules?.enabled;
    return new Set(Array.isArray(configured) ? configured : executive ? defaultExecutive : defaultEmployee);
  }, [executive, profile]);
  const required = useMemo(() => new Set(profile?.fieldRules?.required ?? []), [profile]);
  const completed = statusReadOnly(profile?.status);

  const set = (key: string, value: string, clear: string[] = []) => {
    setValues((current) => ({
      ...current,
      [key]: value,
      ...(["drivingLicenseNo", "dateOfBirth"].includes(key) ? { drivingLicenseExpiry: "" } : {}),
      ...(key === "vehicleRegistrationNo" ? {
        registrationExpiry: "",
        insuranceExpiry: "",
        pollutionExpiry: ""
      } : {})
    }));
    if (clear.length) {
      setVerifications((current) => Object.fromEntries(Object.entries(current).filter(([kind]) => !clear.includes(kind))));
      setVerificationErrors((current) => Object.fromEntries(Object.entries(current).filter(([kind]) => !clear.includes(kind))));
    }
  };

  const verificationKey = (kind: string) => {
    if (kind === "pan") return values.panNumber?.toUpperCase() || "";
    if (kind === "pan_aadhaar") return `${values.panNumber?.toUpperCase() || ""}|${values.aadhaarNumber || ""}`;
    if (kind === "bank") return `${values.bankAccountNo?.toUpperCase() || ""}|${values.ifsc?.toUpperCase() || ""}`;
    if (kind === "pf_uan") return values.pfUan?.toUpperCase() || "";
    if (kind === "dl") return `${values.drivingLicenseNo?.toUpperCase() || ""}|${displayDate(values.dateOfBirth)}`;
    return values.vehicleRegistrationNo?.toUpperCase() || "";
  };

  const currentCheck = (kind: string) => {
    const check = verifications[kind];
    return check?.inputKey === verificationKey(kind) ? check : undefined;
  };
  const verified = (kind: string) => currentCheck(kind)?.verified === true;
  const attempted = (kind: string) => Boolean(currentCheck(kind));

  async function requestVerification(kind: string) {
    const body = {
      kind,
      accountId: account.id,
      profileType: account.profileType,
      fullName: profile?.readOnly.fullName,
      panNumber: values.panNumber,
      aadhaarNumber: values.aadhaarNumber,
      bankAccountNo: values.bankAccountNo,
      ifsc: values.ifsc,
      pfUan: values.pfUan,
      drivingLicenseNo: values.drivingLicenseNo,
      dateOfBirth: values.dateOfBirth,
      vehicleRegNo: values.vehicleRegistrationNo
    };
    const response = await fetch("/api/connect/verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json() as Verification & { error?: string };
    if (!response.ok) throw new Error(payload.error || "Verification failed.");
    const result = { ...payload, kind };
    setVerifications((current) => ({ ...current, [kind]: result }));
    if (kind === "dl" && result.expiryDate) {
      setValues((current) => ({ ...current, drivingLicenseExpiry: result.expiryDate! }));
    }
    if (kind === "vehicle") {
      setValues((current) => ({
        ...current,
        registrationExpiry: result.registrationExpiryDate || current.registrationExpiry,
        insuranceExpiry: result.insuranceExpiryDate || current.insuranceExpiry,
        pollutionExpiry: result.pollutionExpiryDate || current.pollutionExpiry
      }));
    }
    return result;
  }

  async function verify(kind: string) {
    const inputError = verificationInputError(kind, values);
    if (inputError) {
      setVerificationErrors((current) => ({ ...current, [kind]: inputError }));
      return;
    }
    setRunning(kind);
    setError("");
    setVerificationErrors((current) => {
      const next = { ...current };
      delete next[kind];
      return next;
    });
    try {
      if (kind === "pan") {
        setVerifications((current) => {
          const next = { ...current };
          delete next.pan_aadhaar;
          return next;
        });
      }
      await requestVerification(kind);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Verification failed.";
      setVerificationErrors((current) => ({ ...current, [kind]: message }));
    } finally {
      setRunning("");
    }
  }

  function prepareSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    const dateOfBirthError = enabled.has("date_of_birth")
      ? minimumAgeError(values.dateOfBirth)
      : null;
    if (dateOfBirthError) {
      setError(dateOfBirthError);
      return;
    }
    for (const [field, rule] of Object.entries(profileInputRules)) {
      if (!enabled.has(field)) continue;
      if (field === "pf_uan" && pfAnswer !== "yes") continue;
      const valueKey = fieldValueKeys[field] ?? field.replace(/_([a-z])/g, (_, character) => character.toUpperCase());
      const value = values[valueKey] ?? "";
      if (value && !rule.pattern.test(value)) {
        setError(rule.message);
        return;
      }
    }
    const mandatory = [
      ...(enabled.has("pan_number") ? ["pan"] : []),
      ...(enabled.has("pan_number") && enabled.has("aadhaar_number") && attempted("pan") && !currentCheck("pan")?.blockSubmit ? ["pan_aadhaar"] : []),
      ...(enabled.has("bank_account_no") && enabled.has("ifsc") ? ["bank"] : []),
      ...(pfAnswer === "yes" && enabled.has("pf_uan") && (executive || profile?.statutoryApplicability?.includes("pf")) ? ["pf_uan"] : []),
      ...(enabled.has("driving_license_no") ? ["dl"] : []),
      ...(enabled.has("vehicle_reg_no") ? ["vehicle"] : [])
    ];
    if (mandatory.some((kind) => !attempted(kind))) {
      setError("Complete every applicable verification before saving.");
      return;
    }
    const blockedCheck = ["pan", "dl", "pf_uan"]
      .map((kind) => currentCheck(kind))
      .find((item) => item?.blockSubmit);
    if (blockedCheck) {
      setError(blockedCheck.message || "A required identity verification did not match. Registration cannot be submitted.");
      return;
    }
    if (profile?.agreement && !agreementAccepted) {
      setError(`Accept ${profile.agreement.title} before submitting registration.`);
      return;
    }
    setConfirmationOpen(true);
  }

  async function submitProfile() {
    if (!formRef.current || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = new FormData(formRef.current);
      data.set(executive ? "executive_id" : "employee_id", account.id);
      if (executive) data.set("profile_type", account.profileType);
      const currentChecks = Object.values(verifications).filter((item) => currentCheck(item.kind) === item);
      const reviewKinds = new Set(["pan", "pan_aadhaar", "dl", "pf_uan"]);
      const manualReview = currentChecks.some((item) => reviewKinds.has(item.kind) && (!item.verified || item.manualReview));
      data.set("manual_review_required", String(manualReview));
      if (profile?.agreement) {
        data.set("agreement_accepted", String(agreementAccepted));
        data.set("agreement_id", profile.agreement.id);
        data.set("agreement_version", String(profile.agreement.version));
      }
      currentChecks.forEach((item) => data.append("profile_verification_results", JSON.stringify(item)));
      const response = await fetch(endpoint, { method: "POST", body: data });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to save profile.");
      setProfile(payload.profile);
      setNotice("Profile saved.");
      setConfirmationOpen(false);
      if (payload.profile.profilePhotoUrl) onPhoto?.(payload.profile.profilePhotoUrl);
      await onSubmitted?.();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save profile.");
    } finally {
      setSaving(false);
    }
  }

  async function saveDraft() {
    if (!formRef.current) return;
    setDraftSaving(true);
    setError("");
    setNotice("");
    try {
      const form = new FormData(formRef.current);
      const draftData: Record<string, string> = {};
      form.forEach((value, key) => {
        if (typeof value === "string" && key !== "profile_verification_results") {
          draftData[key] = value;
        }
      });
      draftData.has_pf_uan = pfAnswer;
      draftData.has_esi_no = esiAnswer;
      const data = new FormData();
      data.set("account_id", account.id);
      data.set("profile_type", account.profileType);
      data.set("draft_data", JSON.stringify(draftData));
      const currentChecks = Object.values(verifications).filter((item) => currentCheck(item.kind) === item);
      currentChecks.forEach((item) => data.append("profile_verification_results", JSON.stringify(item)));
      for (const slot of Object.keys(draftUploadSlots)) {
        const file = form.get(slot);
        if (file instanceof File && file.size > 0) data.set(slot, file);
      }
      const response = await fetch("/api/connect/profile-draft", { method: "POST", body: data });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to save draft.");
      const draft = payload.draft as ProfileDraft;
      setProfile((current) => {
        if (!current) return current;
        const uploads = { ...current.uploads };
        const uploadUrls = { ...current.uploadUrls };
        Object.entries(draftUploadSlots).forEach(([draftSlot, profileSlot]) => {
          if (draft.uploads?.[draftSlot]) uploads[profileSlot] = true;
          if (draft.uploadUrls?.[draftSlot]) uploadUrls[profileSlot] = draft.uploadUrls[draftSlot];
        });
        return { ...current, uploads, uploadUrls };
      });
      setNotice("Details saved in draft");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save draft.");
    } finally {
      setDraftSaving(false);
    }
  }

  if (!profile && !error) return <Spinner />;
  if (!profile) return <div className="dx-alert error">{error}</div>;

  const supportsExit = ["employee", "user", "contractor", "field_executive", "vendor", "worker"].includes(account.profileType);
  if (completed && supportsExit && exitOpen) {
    return <ConnectExitManagement account={account} onBack={() => setExitOpen(false)} />;
  }

  if (completed) {
    const read = profile.readOnly;
    const sections = [
      { name: executive ? "Profile details" : "Employee details", values: {
        "Full name": read.fullName,
        [executive ? "DropX ID" : "ID"]: read[executive ? "reference" : "employeeId"],
        "Biometric ID": read.biometricId,
        Email: read.email,
        Location: read.location,
        Designation: read.designation,
        "Date of join": read.dateOfJoin,
        "Mobile number": read.mobile,
        Status: profileStatusLabel(profile.status, account.status)
      }},
      { name: "Personal details", values: {
        ...(enabled.has("gender") ? { Gender: values.gender } : {}),
        ...(enabled.has("date_of_birth") ? { "Date of birth": values.dateOfBirth } : {}),
        ...(enabled.has("aadhaar_number") ? { "Aadhaar number": values.aadhaarNumber } : {}),
        ...(enabled.has("pan_number") ? { PAN: values.panNumber } : {}),
        ...(enabled.has("father_name") ? { "Father name": values.fatherName } : {}),
        ...(enabled.has("blood_group") ? { "Blood group": values.bloodGroup } : {}),
        ...(enabled.has("is_handicapped") ? { Handicapped: values.isHandicapped === "true" ? "Yes" : "No" } : {})
      }},
      { name: "Address", values: {
        ...(enabled.has("address") ? { Address: values.address } : {}),
        ...(enabled.has("state_code") ? { "State code": values.stateCode } : {}),
        ...(enabled.has("pincode") ? { Pincode: values.pincode } : {}),
        ...(enabled.has("landmark") ? { Landmark: values.landmark } : {})
      }},
      { name: "Bank details", values: {
        ...(enabled.has("bank_account_no") ? { "Bank account no": values.bankAccountNo } : {}),
        ...(enabled.has("ifsc") ? { IFSC: values.ifsc } : {})
      }},
      ...(["eshram_uan","pf_uan","pf_account_no","esi_no"].some((field) => enabled.has(field)) ? [{ name: "Statutory details", values: {
        ...(enabled.has("eshram_uan") ? { "eShram UAN": values.eshramUan } : {}),
        ...(enabled.has("pf_uan") ? { "PF UAN": values.pfUan } : {}),
        ...(enabled.has("pf_account_no") ? { "PF Account No": values.pfAccountNo } : {}),
        ...(enabled.has("esi_no") ? { "ESI No": values.esiNo } : {})
      }}] : []),
      ...((enabled.has("driving_license_no") || enabled.has("vehicle_reg_no")) ? [{ name: "Driving and vehicle", values: {
        ...(enabled.has("driving_license_no") ? { "Driving license no": values.drivingLicenseNo } : {}),
        ...(enabled.has("driving_license_exp_date") ? { "DL expiry date": values.drivingLicenseExpiry } : {}),
        ...(enabled.has("vehicle_reg_no") ? { "Vehicle reg no": values.vehicleRegistrationNo } : {}),
        ...(enabled.has("vehicle_reg_exp_date") ? { "Reg expiry date": values.registrationExpiry } : {}),
        ...(enabled.has("vehicle_insurance_exp_date") ? { "Vehicle Insurance expiry": values.insuranceExpiry } : {}),
        ...(enabled.has("vehicle_pollution_exp_date") ? { "Pollution expiry date": values.pollutionExpiry } : {})
      }}] : []),
      { name: "Emergency contact", values: {
        ...(enabled.has("emergency_contact_number") ? { "Emergency contact number": values.emergencyContactNumber } : {}),
        ...(enabled.has("emergency_contact_name") ? { "Contact person name": values.emergencyContactName } : {}),
        ...(enabled.has("emergency_contact_relation") ? { Relation: values.emergencyContactRelation } : {})
      }},
      { name: "Uploads", values: Object.fromEntries(Object.entries(profile.uploads).filter(([key]) => {
        const field = ({ aadhaarFront: "aadhaar_front", aadhaarBack: "aadhaar_back", pan: "pan_upload", dlFront: "dl_front", dlBack: "dl_back", photo: "profile_photo" } as Record<string, string>)[key];
        return !field || enabled.has(field);
      }).map(([key, value]) => [title(key), value ? "Uploaded" : "-"])) },
      ...(profile.agreement ? [{ name: "Agreement", values: {
        Agreement: profile.agreement.title,
        Version: String(profile.agreement.version),
        Status: profile.agreement.acceptedAt ? "Accepted" : "Pending"
      }}] : [])
    ].filter((section) => Object.keys(section.values).length);
    const verifyLabels: Record<string, string> = { "Aadhaar number": "pan_aadhaar", PAN: "pan", "Bank account no": "bank", "PF UAN": "pf_uan", "Driving license no": "dl", "Vehicle reg no": "vehicle" };
    const exitDestination = ["employee", "user", "contractor"].includes(account.profileType) ? "People workflow" : "Workforce lifecycle";
    return <div className="dx-profile-view">
      {notice ? <div className="dx-alert success">{notice}</div> : null}
      <div className="dx-profile-hero">
        <small>DROPX LOGISTICS</small><h1>Profile details</h1><i><UserRound /></i>
        <a className="dx-profile-photo-jump" href="#profile-photo-update"><ImagePlus />Update photo</a>
      </div>
      <VerifiedProfilePhotoUpdate account={account} currentPhotoUrl={profile.profilePhotoUrl || account.profilePhotoUrl} onUpdated={(url) => {
        setProfile((current) => current ? { ...current, profilePhotoUrl: url, uploads: { ...current.uploads, photo: true }, uploadUrls: { ...current.uploadUrls, photo: url } } : current);
        onPhoto?.(url);
      }} />
      {sections.map((section, sectionIndex) => <section className={sectionIndex === 0 ? "primary" : ""} key={section.name}>
        {sectionIndex ? <h2>{section.name}</h2> : null}
        <div>{Object.entries(section.values).map(([label, value]) => <ReadTile
          full={["Full name","Address"].includes(label)}
          key={label}
          label={label}
          value={String(value || "")}
          verified={Boolean(verifyLabels[label] && verified(verifyLabels[label]))}
          url={section.name === "Uploads" ? profile.uploadUrls[label.replace(/\s(.)/g, (_, character) => character.toUpperCase()).replace(/^./, (character) => character.toLowerCase())] : undefined}
        />)}</div>
      </section>)}
      {supportsExit ? <button className="dx-profile-exit-cta" onClick={() => setExitOpen(true)} type="button"><i><DoorOpen /></i><span><small>{exitDestination}</small><strong>Resignation & exit</strong><em>Submit a request or track its live status</em></span><ChevronRight /></button> : null}
    </div>;
  }

  if (profile.agreement && !agreementGatePassed) {
    return <div className="dx-agreement-gate">
      <div aria-label="Registration progress" className="dx-agreement-progress">
        <div className="active"><b>1</b><span>Agreement</span></div><i /><div><b>2</b><span>Registration</span></div>
      </div>
      <div className="dx-agreement-gate-heading">
        <small>DROPX CONTRACTOR ONBOARDING</small>
        <h1>{profile.agreement.title}</h1>
        <p>Review the working, payment and custody terms before completing your profile.</p>
        <span>Signing as <strong>{account.name || account.reference || "Delivery contractor"}</strong> · Version {profile.agreement.version}</span>
      </div>
      <div className="dx-agreement-highlights">
        <div><WalletCards /><span><strong>Per-package payment</strong><small>Rate and payable amount are available through the app.</small></span></div>
        <div><ShieldCheck /><span><strong>Shipment & cash custody</strong><small>Return pending shipments and cash to the hub the same day.</small></span></div>
        <div><BriefcaseBusiness /><span><strong>Independent contractor</strong><small>Follow the assigned service metrics and operating rules.</small></span></div>
      </div>
      <div className="dx-agreement-copy dx-agreement-scroll">
        <div><strong>Agreement terms</strong><small>Version {profile.agreement.version}</small></div>
        <p>{profile.agreement.body}</p>
      </div>
      <div className="dx-agreement-action">
        <label className="dx-agreement-accept">
          <input checked={agreementAccepted} onChange={(event) => setAgreementAccepted(event.target.checked)} type="checkbox" />
          <span>I have read and accept this agreement in my individual capacity as an independent contractor.</span>
        </label>
        <button className="dx-save" disabled={!agreementAccepted} onClick={() => setAgreementGatePassed(true)} type="button">
          Accept and continue registration
        </button>
        <small>Registration will go to the HO Workforce team for verification and activation.</small>
      </div>
    </div>;
  }

  const input = (field: string, label: string, options?: { choices?: Array<string | { value: string; label: string }>; readOnly?: boolean }) => {
    if (!enabled.has(field)) return null;
    const valueKey = fieldValueKeys[field] ?? field.replace(/_([a-z])/g, (_, character) => character.toUpperCase());
    const value = values[valueKey] ?? "";
    return <label className="dx-field" key={field}><span>{label}{required.has(field) ? " *" : ""}</span>
      {options?.choices ? <select name={field} onChange={(event) => set(valueKey, event.target.value)} required={required.has(field)} value={value}>
        <option value="">Select</option>
        {options.choices.map((choice) => {
          const option = typeof choice === "string" ? { value: choice, label: choice } : choice;
          return <option key={option.value} value={option.value}>{option.label}</option>;
        })}
      </select> : <input
        inputMode={profileInputRules[field]?.numeric ? "numeric" : "text"}
        maxLength={profileInputRules[field]?.maxLength}
        name={field}
        onChange={(event) => set(valueKey, sanitizeProfileInput(field, event.target.value))}
        readOnly={options?.readOnly}
        required={required.has(field)}
        value={value}
      />}
    </label>;
  };

  const dateField = (field: string, label: string, options?: { readOnly?: boolean; warning?: string }) => {
    if (!enabled.has(field)) return null;
    const valueKey = fieldValueKeys[field] ?? field;
    return <ManualDateField
      key={field}
      label={label}
      name={field}
      onChange={(value) => set(valueKey, value, field === "date_of_birth" ? ["dl"] : [])}
      readOnly={options?.readOnly}
      required={required.has(field)}
      value={values[valueKey] ?? ""}
      warning={options?.warning}
    />;
  };

  const upload = (name: string, label: string, slot: string) => enabled.has(name) ? <label className="dx-upload">
    <span>{label}{required.has(name) ? " *" : ""}</span>
    <input accept="image/*,.pdf" name={name} required={required.has(name) && !profile.uploads[slot]} type="file" />
    <em>{profile.uploads[slot] ? "Uploaded" : "Choose file"}</em>
  </label> : null;

  const dlCheck = currentCheck("dl");
  const vehicleCheck = currentCheck("vehicle");
  const drivingEnabled = ["driving_license_no","driving_license_exp_date","vehicle_reg_no","vehicle_reg_exp_date","vehicle_insurance_exp_date","vehicle_pollution_exp_date"].some((field) => enabled.has(field));

  return <form className="dx-profile-form" onSubmit={prepareSubmit} ref={formRef}>
    <p className="dx-company">{account.companyName}</p>
    <VerifiedProfilePhotoUpdate account={account} currentPhotoUrl={profile.profilePhotoUrl || account.profilePhotoUrl} onUpdated={(url) => {
      setProfile((current) => current ? { ...current, profilePhotoUrl: url, uploads: { ...current.uploads, photo: true }, uploadUrls: { ...current.uploadUrls, photo: url } } : current);
      onPhoto?.(url);
    }} />
    {profile.status.trim().toLowerCase() === "returned" && profile.returnRemarks ? (
      <aside className="dx-return-notice">
        <strong>Profile returned for correction</strong>
        <p>{profile.returnRemarks}</p>
      </aside>
    ) : null}
    <ProfileSection title={executive ? "Profile details" : "Employee details"}>
      {Object.entries(profile.readOnly).map(([label, value]) => <div className="dx-readonly" key={label}><span>{title(label)}</span><strong>{value || "-"}</strong></div>)}
    </ProfileSection>
    <ProfileSection title="Personal details">
      {input("gender","Gender",{ choices: ["Male","Female","Other"] })}
      {dateField("date_of_birth","Date of birth",{ warning: minimumAgeError(values.dateOfBirth) ?? "" })}
      {enabled.has("pan_number") ? <>
        <VerifyField label={`PAN${required.has("pan_number") ? " *" : ""}`} name="pan_number" onChange={(value) => set("panNumber", value, ["pan","pan_aadhaar"])} onVerify={() => verify("pan")} running={running === "pan"} value={values.panNumber || ""} checked={attempted("pan")} verified={verified("pan")} error={verificationErrors.pan || verificationInputError("pan", values)} required={required.has("pan_number")} />
        <VerificationText checks={[currentCheck("pan")]} />
      </> : null}
      {enabled.has("aadhaar_number") ? <>
        <VerifyField
          label={`Aadhaar number${required.has("aadhaar_number") ? " *" : ""}`}
          name="aadhaar_number"
          onChange={(value) => set("aadhaarNumber", value, ["pan_aadhaar"])}
          onVerify={() => verify("pan_aadhaar")}
          running={running === "pan_aadhaar"}
          value={values.aadhaarNumber || ""}
          checked={attempted("pan_aadhaar")}
          verified={verified("pan_aadhaar")}
          disabled={!attempted("pan") || Boolean(currentCheck("pan")?.blockSubmit)}
          placeholder={!attempted("pan") || Boolean(currentCheck("pan")?.blockSubmit) ? "Verify PAN first" : undefined}
          error={verificationErrors.pan_aadhaar || verificationInputError("pan_aadhaar", values)}
          required={required.has("aadhaar_number")}
        />
        <VerificationText checks={[currentCheck("pan_aadhaar")]} />
      </> : null}
      {input("father_name","Father name")}
      {input("blood_group","Blood group",{ choices: bloodGroups })}
      {input("is_handicapped","Handicapped",{ choices: [{ value: "false", label: "No" }, { value: "true", label: "Yes" }] })}
    </ProfileSection>
    <ProfileSection title="Address">
      {input("address","Address")}{input("state_code","State code",{ choices: states })}{input("pincode","Pincode")}{input("landmark","Landmark")}
    </ProfileSection>
    <ProfileSection title="Bank details">
      {enabled.has("bank_account_no") ? <label className="dx-field"><span>Bank account no{required.has("bank_account_no") ? " *" : ""}</span><input maxLength={30} name="bank_account_no" onChange={(event) => set("bankAccountNo", sanitizeProfileInput("bank_account_no", event.target.value), ["bank"])} required={required.has("bank_account_no")} value={values.bankAccountNo || ""} /></label> : null}
      {enabled.has("ifsc") ? <>
        <VerifyField label={`IFSC${required.has("ifsc") ? " *" : ""}`} name="ifsc" onChange={(value) => set("ifsc", value, ["bank"])} onVerify={() => verify("bank")} running={running === "bank"} value={values.ifsc || ""} verified={verified("bank")} error={verificationErrors.bank || verificationInputError("bank", values)} required={required.has("ifsc")} />
        <VerificationText checks={[currentCheck("bank")]} />
      </> : null}
    </ProfileSection>
    {["eshram_uan","pf_uan","pf_account_no","esi_no"].some((field) => enabled.has(field)) ? <ProfileSection title="Statutory details">
      {input("eshram_uan","eShram UAN")}
      {(executive || profile.statutoryApplicability?.includes("pf")) && enabled.has("pf_uan") ? <>
        <label className="dx-field">
          <span>Do you have PF UAN? *</span>
          <select required value={pfAnswer} onChange={(event) => {
            const answer = event.target.value;
            setPfAnswer(answer);
            if (answer !== "yes") set("pfUan", "", ["pf_uan"]);
          }}>
            <option value="">Select</option><option value="yes">Yes</option><option value="no">No</option>
          </select>
        </label>
        {pfAnswer === "yes" ? <>
          <VerifyField label="PF UAN *" name="pf_uan" onChange={(value) => set("pfUan", value, ["pf_uan"])} onVerify={() => verify("pf_uan")} running={running === "pf_uan"} value={values.pfUan || ""} checked={attempted("pf_uan")} verified={verified("pf_uan")} error={verificationErrors.pf_uan || verificationInputError("pf_uan", values)} required />
          <VerificationText checks={[currentCheck("pf_uan")]} />
        </> : null}
      </> : null}
      {executive || profile.statutoryApplicability?.includes("pf") ? input("pf_account_no","PF Account No") : null}
      {(executive || profile.statutoryApplicability?.includes("esi")) && enabled.has("esi_no") ? <>
        <label className="dx-field">
          <span>Do you have ESI No? *</span>
          <select required value={esiAnswer} onChange={(event) => {
            const answer = event.target.value;
            setEsiAnswer(answer);
            if (answer !== "yes") set("esiNo", "");
          }}>
            <option value="">Select</option><option value="yes">Yes</option><option value="no">No</option>
          </select>
        </label>
        {esiAnswer === "yes" ? <label className="dx-field"><span>ESI No *</span><input name="esi_no" onChange={(event) => set("esiNo", event.target.value)} required value={values.esiNo || ""} /></label> : null}
      </> : null}
    </ProfileSection> : null}
    {drivingEnabled ? <ProfileSection title="Driving and vehicle">
      {enabled.has("driving_license_no") ? <>
        <VerifyField label={`Driving license no${required.has("driving_license_no") ? " *" : ""}`} name="driving_license_no" onChange={(value) => set("drivingLicenseNo", value, ["dl"])} onVerify={() => verify("dl")} running={running === "dl"} value={values.drivingLicenseNo || ""} checked={attempted("dl")} verified={verified("dl")} error={verificationErrors.dl || verificationInputError("dl", values)} required={required.has("driving_license_no")} />
        <VerificationText checks={[dlCheck]} />
      </> : null}
      {dateField("driving_license_exp_date","DL expiry date",{ readOnly: Boolean(dlCheck?.expiryDate), warning: expired(values.drivingLicenseExpiry) ? "Driving licence has expired." : "" })}
      {enabled.has("vehicle_reg_no") ? <>
        <VerifyField label={`Vehicle reg no${required.has("vehicle_reg_no") ? " *" : ""}`} name="vehicle_reg_no" onChange={(value) => set("vehicleRegistrationNo", value, ["vehicle"])} onVerify={() => verify("vehicle")} running={running === "vehicle"} value={values.vehicleRegistrationNo || ""} verified={verified("vehicle")} error={verificationErrors.vehicle || verificationInputError("vehicle", values)} required={required.has("vehicle_reg_no")} />
        <VerificationText checks={[vehicleCheck]} />
      </> : null}
      {dateField("vehicle_reg_exp_date","Reg expiry date",{ readOnly: Boolean(vehicleCheck?.registrationExpiryDate), warning: expired(values.registrationExpiry) ? "Vehicle registration has expired." : "" })}
      {dateField("vehicle_insurance_exp_date","Vehicle Insurance expiry",{ readOnly: Boolean(vehicleCheck?.insuranceExpiryDate), warning: expired(values.insuranceExpiry) ? "Vehicle insurance has expired." : "" })}
      {!vehicleCheck?.fuelType?.toLowerCase().includes("electric") ? dateField("vehicle_pollution_exp_date","Pollution expiry date",{ readOnly: Boolean(vehicleCheck?.pollutionExpiryDate), warning: expired(values.pollutionExpiry) ? "Pollution certificate has expired." : "" }) : null}
    </ProfileSection> : null}
    <ProfileSection title="Emergency contact">
      {input("emergency_contact_number","Emergency contact number")}{input("emergency_contact_name","Contact person name")}{input("emergency_contact_relation","Relation",{ choices: relations })}
    </ProfileSection>
    <ProfileSection title="Uploads">
      {upload("aadhaar_front","Aadhaar front","aadhaarFront")}{upload("aadhaar_back","Aadhaar back","aadhaarBack")}{upload("pan_upload","PAN upload","pan")}{upload("dl_front","DL front","dlFront")}{upload("dl_back","DL back","dlBack")}{upload("profile_photo","Photo upload","photo")}
    </ProfileSection>
    {profile.agreement ? <ProfileSection title="Mandatory agreement">
      <div className="dx-agreement-copy">
        <strong>{profile.agreement.title}</strong>
        <small>Version {profile.agreement.version}</small>
        <p>Accepted for this registration. The signed acceptance is recorded when you submit the completed registration.</p>
      </div>
      <button className="dx-draft-save" onClick={() => setAgreementGatePassed(false)} type="button">Review agreement</button>
    </ProfileSection> : null}
    {error ? <div className="dx-alert error">{error}</div> : null}
    {notice ? <div className="dx-alert success">{notice}</div> : null}
    <div className="dx-form-actions">
      <button className="dx-draft-save" disabled={saving || draftSaving} onClick={saveDraft} type="button">
        {draftSaving ? "Saving draft..." : "Save draft"}
      </button>
      <button className="dx-save" disabled={saving || draftSaving} type="submit">{saving ? "Submitting..." : "Submit"}</button>
    </div>
    {confirmationOpen ? (
      <div className="dx-submit-confirmation-backdrop" role="presentation">
        <section aria-labelledby="dx-submit-confirmation-title" aria-modal="true" className="dx-submit-confirmation" role="alertdialog">
          <h2 id="dx-submit-confirmation-title">Submit registration?</h2>
          <p>Please confirm that the details are correct. You may not be able to edit the registration after submission.</p>
          {error ? <div className="dx-alert error">{error}</div> : null}
          <div>
            <button className="dx-confirm-cancel" disabled={saving} onClick={() => setConfirmationOpen(false)} type="button">Cancel</button>
            <button className="dx-confirm-submit" disabled={saving} onClick={submitProfile} type="button">
              {saving ? <><span className="dx-button-spinner" aria-hidden="true" />Submitting...</> : "Submit"}
            </button>
          </div>
        </section>
      </div>
    ) : null}
  </form>;
}

function ProfileSection({ title: heading, children }: { title: string; children: ReactNode }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children;
  if (Array.isArray(items) && !items.length) return null;
  return <section className="dx-form-section"><h2>{heading}</h2><div>{items}</div></section>;
}

function VerificationText({ checks }: { checks: Array<Verification | undefined> }) {
  return <>{checks.filter(Boolean).map((check) => {
    const holder = check!.name || check!.accountName || check!.ownerName;
    const status = check!.message || (check!.verified ? "Verified." : "Verification failed.");
    const tone = check!.verified ? "ok" : check!.manualReview ? "review" : "fail";
    const Icon = check!.verified ? ShieldCheck : check!.manualReview ? TriangleAlert : CircleX;
    const identityCheck = ["pan", "dl", "pf_uan"].includes(check!.kind);
    if (identityCheck) {
      const label = holder || status;
      return <div className={`dx-verification ${tone}`} key={check!.kind}>
        <Icon />
        <span><strong>{label}</strong>{holder ? <small>{status}</small> : null}</span>
      </div>;
    }
    const message = holder
      ? `${holder}${check!.fuelType ? ` | Fuel type: ${check!.fuelType}` : ""}${check!.verified ? "" : ` | ${status}`}`
      : status;
    return <p className={`dx-verification ${tone}`} key={check!.kind}><Icon />{message}</p>;
  })}</>;
}
