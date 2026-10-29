"use client";

import {
  BadgeCheck, BriefcaseBusiness, CalendarDays, ChevronRight, CircleX, DoorOpen, Download, Fingerprint,
  LockKeyhole, Mail, MapPin, Pencil, Phone, ShieldCheck, TriangleAlert, UserRound, WalletCards
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { minimumAgeError } from "../lib/profile-age";
import { ConnectExitManagement } from "./connect-exit-management";
import { VerifiedProfilePhotoUpdate } from "./verified-profile-photo-update";
import { readJsonResponse, userFacingError } from "../lib/user-facing-error";
import { compressFormImages, formFileBytes, MAX_UPLOAD_REQUEST_BYTES, UPLOAD_TOO_LARGE_MESSAGE } from "../lib/compress-form-images";
import { isPureElectricFuel } from "@/lib/vehicle-fuel";
import {
  countryCodeOptions,
  emergencyContactMatchesMobile,
  MOBILE_EMERGENCY_CONTACT_CONFLICT_ERROR,
  normalizeProfileEditMobile
} from "@/lib/country-codes";
import {
  matchingProfileVerification,
  profileEditVerificationPlan,
  profileVerificationExpiryPatch
} from "@/lib/profile-verification-state";

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
  designationCode?: string | null;
  providerMappingRequired?: boolean;
  activationOnly?: boolean;
  betaWorkspaceActive?: boolean;
  onboardingBeta?: boolean;
  readOnlyPreview?: boolean;
  activationStage?: string | null;
};

type Profile = {
  betaRegistrationReady?: boolean;
  mobileCountryCode?: string;
  mobileNumber?: string;
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

type ProfileEditOtpState = {
  open: boolean;
  requestId: string;
  leg: "current" | "new";
  currentCode: string;
  newCode: string;
  newOtpSent: boolean;
  mobileChanged: boolean;
  currentMasked: string;
  newMasked: string;
  busy: boolean;
  error: string;
  message: string;
};

type ProfileEditBootstrap = {
  values: Record<string, string | boolean | null>;
  mobileCountryCode: string;
  mobileNumber: string;
  sourceUpdatedAt: string;
};

type ProfileEditViewSnapshot = {
  values: Record<string, string>;
  verifications: Record<string, Verification>;
  verificationErrors: Record<string, string>;
  pfAnswer: string;
  esiAnswer: string;
};

const emptyProfileEditOtp: ProfileEditOtpState = {
  open: false,
  requestId: "",
  leg: "current",
  currentCode: "",
  newCode: "",
  newOtpSent: false,
  mobileChanged: false,
  currentMasked: "",
  newMasked: "",
  busy: false,
  error: "",
  message: ""
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
    <div className={`dx-input-action${disabled && placeholder ? " dx-verify-disabled" : ""}${verified ? " dx-input-verified" : ""}`}>
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
      {verified ? <span className="dx-verified-tag"><BadgeCheck aria-hidden="true" />Verified</span> : null}
    </div>
    {error ? <small className="dx-field-error">{error}</small> : null}
  </label>;
}

function VerificationAction({ label, onVerify, running, checked, verified, disabled, error }: {
  label: string;
  onVerify: () => void;
  running?: boolean;
  checked?: boolean;
  verified?: boolean;
  disabled?: boolean;
  error?: string;
}) {
  return <div className="dx-field dx-verification-action">
    <span>{label}</span>
    <div className="dx-verification-action-control">
      {!checked ? <button disabled={disabled || running || Boolean(error)} onClick={onVerify} type="button">{running ? <i className="mini-spin" /> : "Verify"}</button> : null}
      {verified ? <span className="dx-verified-tag"><BadgeCheck aria-hidden="true" />Verified</span> : null}
      {checked && !verified ? <span className="dx-verification-action-state">Checked</span> : null}
    </div>
    {error ? <small className="dx-field-error">{error}</small> : null}
  </div>;
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

export function ConnectProfileApp({ account, onPhoto, onSubmitted, readOnly = false }: { account: AppAccount; onPhoto?: (url: string) => void; onSubmitted?: () => Promise<void> | void; readOnly?: boolean }) {
  const executive = account.profileType !== "employee" && account.profileType !== "user";
  const isolatedPilot = Boolean(account.onboardingBeta && account.activationStage?.startsWith("amazon_email_pilot:"));
  const endpoint = isolatedPilot ? "/api/connect/pilot-profile" : executive ? "/api/connect/field-executive-profile" : "/api/connect/profile";
  const query = isolatedPilot
    ? `candidateId=${account.id}`
    : executive
    ? `executiveId=${account.id}&profileType=${encodeURIComponent(account.profileType)}`
    : `employeeId=${account.id}`;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [verifications, setVerifications] = useState<Record<string, Verification>>({});
  const [editBaselineVerifications, setEditBaselineVerifications] = useState<Record<string, Verification>>({});
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
  const [editing, setEditing] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [editOriginalValues, setEditOriginalValues] = useState<Record<string, string>>({});
  const [editSourceUpdatedAt, setEditSourceUpdatedAt] = useState("");
  const [editOtp, setEditOtp] = useState<ProfileEditOtpState>(emptyProfileEditOtp);
  const [chosenUploads, setChosenUploads] = useState<Record<string, { fileName: string; previewUrl: string | null }>>({});
  const chosenUploadsRef = useRef(chosenUploads);
  const editViewSnapshotRef = useRef<ProfileEditViewSnapshot | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const newOtpInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    Object.values(chosenUploadsRef.current).forEach((entry) => {
      if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    });
  }, []);

  useEffect(() => {
    if (editOtp.open && editOtp.leg === "new" && editOtp.newOtpSent) {
      newOtpInputRef.current?.focus();
    }
  }, [editOtp.leg, editOtp.newOtpSent, editOtp.open]);

  const chooseUpload = (name: string, file: File | undefined) => {
    const previous = chosenUploadsRef.current[name];
    if (previous?.previewUrl) URL.revokeObjectURL(previous.previewUrl);
    const next = { ...chosenUploadsRef.current };
    if (file) {
      next[name] = { fileName: file.name, previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null };
    } else {
      delete next[name];
    }
    chosenUploadsRef.current = next;
    setChosenUploads(next);
  };

  useEffect(() => {
    Promise.all([
      fetch(`${endpoint}?${query}`).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error);
        return payload.profile as Profile;
      }),
      isolatedPilot
        ? Promise.resolve({ verifications: [] })
        : fetch(`/api/connect/verification?accountId=${account.id}&profileType=${account.profileType}`).then((response) => response.json()),
      fetch(`/api/connect/profile-draft?accountId=${account.id}&profileType=${account.profileType}`).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to load draft.");
        return (payload.draft ?? null) as ProfileDraft | null;
      })
    ]).then(([nextProfile, checks, draft]) => {
      const next = nextProfile as Profile;
      // Completed ordinary profiles are sourced from their profile record, never
      // from an older registration draft. The isolated pilot stores its submitted
      // values in the draft record, so that view must continue to hydrate from it.
      const registrationDraft = isolatedPilot || !statusReadOnly(next.status) ? draft : null;
      const uploads = { ...next.uploads };
      const uploadUrls = { ...next.uploadUrls };
      if (registrationDraft) {
        Object.entries(draftUploadSlots).forEach(([draftSlot, profileSlot]) => {
          if (registrationDraft.uploads?.[draftSlot]) uploads[profileSlot] = true;
          if (registrationDraft.uploadUrls?.[draftSlot]) uploadUrls[profileSlot] = registrationDraft.uploadUrls[draftSlot];
        });
      }
      const editable: Record<string, string> = {
        ...(next.editable ?? {}),
        ...(registrationDraft ? draftEditableValues(registrationDraft.data) : {}),
        mobileCountryCode: next.mobileCountryCode || "91",
        mobileNumber: next.mobileNumber || ""
      };
      const draftChecks = registrationDraft?.verificationResults?.length ? registrationDraft.verificationResults : null;
      setProfile({ ...next, uploads, uploadUrls });
      setEditing(false);
      setEditLoading(false);
      setEditOriginalValues({});
      setEditSourceUpdatedAt("");
      setEditBaselineVerifications({});
      editViewSnapshotRef.current = null;
      setEditOtp(emptyProfileEditOtp);
      const agreementAlreadyAccepted = Boolean(next.agreement?.acceptedAt);
      setAgreementAccepted(agreementAlreadyAccepted);
      setAgreementGatePassed(agreementAlreadyAccepted);
      setValues(editable);
      setPfAnswer(registrationDraft?.data?.has_pf_uan ?? (editable.pfUan ? "yes" : ""));
      setEsiAnswer(registrationDraft?.data?.has_esi_no ?? (editable.esiNo ? "yes" : ""));
      setVerifications(isolatedPilot ? {} : Object.fromEntries((draftChecks ?? checks.verifications ?? []).map((item: Verification) => [item.kind, item])));
      if (registrationDraft) setNotice("Draft restored.");
      if (next.profilePhotoUrl) onPhoto?.(next.profilePhotoUrl);
    }).catch((reason) => setError(userFacingError(reason, "Unable to load profile. Please try again.")));
  }, [account.id, account.profileType, endpoint, isolatedPilot, query]);

  const enabled = useMemo(() => {
    const configured = profile?.fieldRules?.enabled;
    return new Set(Array.isArray(configured) ? configured : executive ? defaultExecutive : defaultEmployee);
  }, [executive, profile]);
  const required = useMemo(() => new Set(profile?.fieldRules?.required ?? []), [profile]);
  const editValueChanged = (key: string) => (values[key] ?? "") !== (editOriginalValues[key] ?? "");
  const nativeFieldRequired = (field: string, valueKey = fieldValueKeys[field] ?? field) =>
    required.has(field) && (!editing || editValueChanged(valueKey));
  const editVerificationPlan = profileEditVerificationPlan({
    values,
    originalValues: editOriginalValues,
    requirePfUan: pfAnswer === "yes" && enabled.has("pf_uan") && Boolean(executive || profile?.statutoryApplicability?.includes("pf"))
  });
  const completed = statusReadOnly(profile?.status) && !editing;
  const canEditProfile = !readOnly && !isolatedPilot &&
    ["employee", "workforce", "field_executive", "contractor", "vendor"].includes(account.profileType) &&
    String(profile?.status ?? "").trim().toLowerCase() === "active";

  const verificationKeyForValues = (kind: string, source: Record<string, string>) => {
    const upper = (input: string | undefined) => String(input ?? "").trim().toUpperCase();
    const plain = (input: string | undefined) => String(input ?? "").trim();
    if (kind === "pan") return upper(source.panNumber);
    if (kind === "pan_aadhaar") return `${upper(source.panNumber)}|${plain(source.aadhaarNumber)}`;
    if (kind === "bank") return `${upper(source.bankAccountNo)}|${upper(source.ifsc)}`;
    if (kind === "pf_uan") return upper(source.pfUan);
    if (kind === "dl") return `${upper(source.drivingLicenseNo)}|${displayDate(plain(source.dateOfBirth))}`;
    return upper(source.vehicleRegistrationNo);
  };

  const set = (key: string, value: string, clear: string[] = []) => {
    setValues((current) => {
      const next = { ...current, [key]: value };
      if (["drivingLicenseNo", "dateOfBirth"].includes(key)) {
        Object.assign(next, profileVerificationExpiryPatch({
          kind: "dl",
          inputKey: verificationKeyForValues("dl", next),
          originalInputKey: verificationKeyForValues("dl", editOriginalValues),
          editing,
          fresh: verifications.dl,
          baseline: editBaselineVerifications.dl,
          originalValues: {
            drivingLicenseExpiry: editOriginalValues.drivingLicenseExpiry || "",
            registrationExpiry: editOriginalValues.registrationExpiry || "",
            insuranceExpiry: editOriginalValues.insuranceExpiry || "",
            pollutionExpiry: editOriginalValues.pollutionExpiry || ""
          }
        }));
      }
      if (key === "vehicleRegistrationNo") {
        Object.assign(next, profileVerificationExpiryPatch({
          kind: "vehicle",
          inputKey: verificationKeyForValues("vehicle", next),
          originalInputKey: verificationKeyForValues("vehicle", editOriginalValues),
          editing,
          fresh: verifications.vehicle,
          baseline: editBaselineVerifications.vehicle,
          originalValues: {
            drivingLicenseExpiry: editOriginalValues.drivingLicenseExpiry || "",
            registrationExpiry: editOriginalValues.registrationExpiry || "",
            insuranceExpiry: editOriginalValues.insuranceExpiry || "",
            pollutionExpiry: editOriginalValues.pollutionExpiry || ""
          }
        }));
      }
      return next;
    });
    if (clear.length) {
      // Exact input-key matching hides stale checks during an edit. Retaining
      // edit-only checks also restores the tag if the user reverts a value.
      if (!editing) {
        setVerifications((current) => Object.fromEntries(Object.entries(current).filter(([kind]) => !clear.includes(kind))));
      }
      setVerificationErrors((current) => Object.fromEntries(Object.entries(current).filter(([kind]) => !clear.includes(kind))));
    }
  };

  const verificationKey = (kind: string) => verificationKeyForValues(kind, values);

  const currentCheck = (kind: string) => {
    return matchingProfileVerification({
      inputKey: verificationKey(kind),
      editing,
      fresh: verifications[kind],
      baseline: editBaselineVerifications[kind]
    });
  };
  const freshCheck = (kind: string) => matchingProfileVerification({
    inputKey: verificationKey(kind),
    editing: false,
    fresh: verifications[kind]
  });
  const requiredEditKinds = new Set<string>(editVerificationPlan.requirements.map(({ kind }) => kind));
  // Saved checks remain visible for unchanged values. Any verification-bound
  // edit must use a fresh session-bound provider result, even when a legacy raw
  // value normalizes to the same input key as the saved check.
  const actionCheck = (kind: string) => editing && requiredEditKinds.has(kind)
    ? freshCheck(kind)
    : currentCheck(kind);
  const verified = (kind: string) => actionCheck(kind)?.verified === true;
  const attempted = (kind: string) => Boolean(actionCheck(kind));

  async function requestVerification(kind: string, profileEdit = false) {
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
      vehicleRegNo: values.vehicleRegistrationNo,
      ...(profileEdit ? { profileEdit: true } : {})
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
      if (kind === "pan" && !editing) {
        setVerifications((current) => {
          const next = { ...current };
          delete next.pan_aadhaar;
          return next;
        });
      }
      await requestVerification(kind, editing);
    } catch (reason) {
      const message = userFacingError(reason, "Verification could not be completed. Please try again.");
      setVerificationErrors((current) => ({ ...current, [kind]: message }));
    } finally {
      setRunning("");
    }
  }

  function registrationFieldError() {
    const dateOfBirthError = enabled.has("date_of_birth")
      ? minimumAgeError(values.dateOfBirth)
      : null;
    if (dateOfBirthError) return dateOfBirthError;

    for (const [field, rule] of Object.entries(profileInputRules)) {
      if (!enabled.has(field)) continue;
      if (field === "pf_uan" && pfAnswer !== "yes") continue;
      const valueKey = fieldValueKeys[field] ?? field.replace(/_([a-z])/g, (_, character) => character.toUpperCase());
      const value = values[valueKey] ?? "";
      if (value && !rule.pattern.test(value)) return rule.message;
    }

    return "";
  }

  function profileEditFieldError() {
    const changed = (key: string) => (values[key] || "") !== (editOriginalValues[key] || "");
    if (enabled.has("date_of_birth") && changed("dateOfBirth")) {
      const dateOfBirthError = minimumAgeError(values.dateOfBirth);
      if (dateOfBirthError) return dateOfBirthError;
    }

    for (const [field, rule] of Object.entries(profileInputRules)) {
      if (!enabled.has(field)) continue;
      if (field === "pf_uan" && pfAnswer !== "yes") continue;
      const valueKey = fieldValueKeys[field] ?? field.replace(/_([a-z])/g, (_, character) => character.toUpperCase());
      if (!changed(valueKey)) continue;
      const value = values[valueKey] ?? "";
      if (value && !rule.pattern.test(value)) return rule.message;
    }

    return "";
  }

  function mobileEmergencyContactConflictError() {
    if (!values.mobileNumber || !values.emergencyContactNumber) return "";
    try {
      const mobile = normalizeProfileEditMobile(
        values.mobileNumber,
        values.mobileCountryCode || "91"
      );
      return emergencyContactMatchesMobile(mobile, values.emergencyContactNumber)
        ? MOBILE_EMERGENCY_CONTACT_CONFLICT_ERROR
        : "";
    } catch {
      // The existing mobile-format validation owns malformed mobile errors.
      return "";
    }
  }

  function registrationSubmissionError() {
    const fieldError = registrationFieldError();
    if (fieldError) return fieldError;
    const contactConflictError = mobileEmergencyContactConflictError();
    if (contactConflictError) return contactConflictError;

    // Keep registration verification rules independent from self-service edit.
    // Optional blank fields have nothing to verify and do not block submission.
    const applies = (field: string, value: string | undefined) => enabled.has(field) && (required.has(field) || Boolean(value?.trim()));
    const mandatory: Array<[string, string]> = [
      ...(applies("pan_number", values.panNumber) ? [["pan", "PAN"] as [string, string]] : []),
      ...(applies("pan_number", values.panNumber) && applies("aadhaar_number", values.aadhaarNumber) ? [["pan_aadhaar", "Aadhaar number"] as [string, string]] : []),
      ...(applies("bank_account_no", values.bankAccountNo) && applies("ifsc", values.ifsc) ? [["bank", "Bank account"] as [string, string]] : []),
      ...(pfAnswer === "yes" && enabled.has("pf_uan") && (executive || profile?.statutoryApplicability?.includes("pf")) ? [["pf_uan", "PF UAN"] as [string, string]] : []),
      ...(applies("driving_license_no", values.drivingLicenseNo) ? [["dl", "Driving license no"] as [string, string]] : []),
      ...(applies("vehicle_reg_no", values.vehicleRegistrationNo) ? [["vehicle", "Vehicle reg no"] as [string, string]] : [])
    ];
    const pending = isolatedPilot ? [] : mandatory.filter(([kind]) => !attempted(kind)).map(([, label]) => label);
    if (pending.length) {
      return `Tap Verify for ${pending.join(", ")} before submitting.`;
    }

    const blockedCheck = ["pan", "pan_aadhaar", "dl", "pf_uan"]
      .map((kind) => currentCheck(kind))
      .find((item) => item?.blockSubmit);
    if (!isolatedPilot && blockedCheck) {
      return blockedCheck.message || "A required identity verification did not match.";
    }
    if (profile?.agreement && !agreementAccepted) {
      return `Accept ${profile.agreement.title} before submitting registration.`;
    }
    return "";
  }

  function profileEditSubmissionError() {
    const fieldError = profileEditFieldError();
    if (fieldError) return fieldError;

    if (!countryCodeOptions.some((option) => option.code === values.mobileCountryCode)) return "Select a supported mobile country code.";
    if (!/^\d{6,14}$/.test(values.mobileNumber || "")) return "Enter a 6 to 14 digit mobile number.";
    const contactConflictError = mobileEmergencyContactConflictError();
    if (contactConflictError) return contactConflictError;

    if (editVerificationPlan.error) return editVerificationPlan.error;

    const mandatory: Array<[string, string]> = editVerificationPlan.requirements
      .map(({ kind, label }) => [kind, label]);
    const pending = isolatedPilot ? [] : mandatory.filter(([kind]) => !attempted(kind)).map(([, label]) => label);
    if (pending.length) {
      return `Tap Verify for ${pending.join(", ")} before submitting.`;
    }

    const requiredKinds = new Set(mandatory.map(([kind]) => kind));
    const blockedCheck = ["pan", "pan_aadhaar", "dl", "pf_uan"]
      .filter((kind) => requiredKinds.has(kind))
      .map((kind) => actionCheck(kind))
      .find((item) => item?.blockSubmit);
    if (!isolatedPilot && blockedCheck) {
      return blockedCheck.message || "A required identity verification did not match.";
    }
    return "";
  }

  function prepareSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (editing) {
      const editError = profileEditSubmissionError();
      if (editError) {
        setError(editError);
        return;
      }
      void startProfileEdit();
      return;
    }

    const registrationError = registrationSubmissionError();
    if (registrationError) {
      setError(registrationError);
      return;
    }
    setConfirmationOpen(true);
  }

  function editablePayload() {
    const fields: Array<[string, string]> = [
      ["gender", "gender"], ["date_of_birth", "dateOfBirth"], ["aadhaar_number", "aadhaarNumber"],
      ["pan_number", "panNumber"], ["eshram_uan", "eshramUan"], ["is_handicapped", "isHandicapped"],
      ["address", "address"], ["pincode", "pincode"], ["landmark", "landmark"], ["state_code", "stateCode"],
      ["father_name", "fatherName"], ["blood_group", "bloodGroup"], ["bank_account_no", "bankAccountNo"],
      ["ifsc", "ifsc"], ["pf_uan", "pfUan"], ["pf_account_no", "pfAccountNo"], ["esi_no", "esiNo"],
      ["driving_license_no", "drivingLicenseNo"], ["driving_license_exp_date", "drivingLicenseExpiry"],
      ["vehicle_reg_no", "vehicleRegistrationNo"], ["vehicle_reg_exp_date", "registrationExpiry"],
      ["vehicle_insurance_exp_date", "insuranceExpiry"], ["vehicle_pollution_exp_date", "pollutionExpiry"],
      ["emergency_contact_name", "emergencyContactName"], ["emergency_contact_number", "emergencyContactNumber"],
      ["emergency_contact_relation", "emergencyContactRelation"]
    ];
    return Object.fromEntries(fields
      .filter(([field, key]) => enabled.has(field) && (values[key] ?? "") !== (editOriginalValues[key] ?? ""))
      .map(([, key]) => [key, values[key] ?? ""]));
  }

  async function beginProfileEdit() {
    if (editing || editLoading || saving) return;
    setEditLoading(true);
    setError("");
    setNotice("");
    try {
      const params = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const verificationParams = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const [payload, checks] = await Promise.all([
        fetch(`/api/connect/profile-edit?${params}`, { cache: "no-store" }).then((response) =>
          readJsonResponse<ProfileEditBootstrap>(response, "Unable to load current profile details.")
        ),
        fetch(`/api/connect/verification?${verificationParams}`, { cache: "no-store" })
          .then((response) => readJsonResponse<{ verifications?: Verification[] }>(response, "Unable to load profile checks."))
          .catch(() => ({ verifications: [] as Verification[] }))
      ]);
      if (!payload.values || typeof payload.values !== "object" || Array.isArray(payload.values)) {
        throw new Error("Current profile details are unavailable. Reload and try again.");
      }
      if (!String(payload.sourceUpdatedAt || "").trim()) {
        throw new Error("Current profile version is unavailable. Reload and try again.");
      }

      const editValues = Object.fromEntries(Object.entries(payload.values).map(([key, value]) => [
        key,
        value === null || value === undefined ? "" : String(value)
      ])) as Record<string, string>;
      const nextValues: Record<string, string> = {
        ...editValues,
        mobileCountryCode: String(payload.mobileCountryCode || "91"),
        mobileNumber: String(payload.mobileNumber || "")
      };
      editViewSnapshotRef.current = {
        values: { ...values },
        verifications: { ...verifications },
        verificationErrors: { ...verificationErrors },
        pfAnswer,
        esiAnswer
      };
      setValues(nextValues);
      setEditOriginalValues({ ...nextValues });
      setEditSourceUpdatedAt(String(payload.sourceUpdatedAt || ""));
      setPfAnswer(nextValues.pfUan ? "yes" : "no");
      setEsiAnswer(nextValues.esiNo ? "yes" : "no");
      // Registration drafts and their verification snapshots must never seed a
      // self-service edit. Canonical saved checks are display-only baselines for
      // unchanged values; changed identity fields obtain fresh edit-bound checks.
      setEditBaselineVerifications(Object.fromEntries(
        (checks.verifications ?? []).map((item) => [item.kind, item])
      ));
      setVerifications({});
      setVerificationErrors({});
      setEditOtp(emptyProfileEditOtp);
      setConfirmationOpen(false);
      setEditing(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (reason) {
      setError(userFacingError(reason, "Unable to load current profile details. Please try again."));
    } finally {
      setEditLoading(false);
    }
  }

  function cancelProfileEdit() {
    const snapshot = editViewSnapshotRef.current;
    if (snapshot) {
      setValues(snapshot.values);
      setVerifications(snapshot.verifications);
      setVerificationErrors(snapshot.verificationErrors);
      setPfAnswer(snapshot.pfAnswer);
      setEsiAnswer(snapshot.esiAnswer);
    } else {
      setValues({ ...editOriginalValues });
      setPfAnswer(editOriginalValues.pfUan ? "yes" : "no");
      setEsiAnswer(editOriginalValues.esiNo ? "yes" : "no");
    }
    editViewSnapshotRef.current = null;
    setEditOriginalValues({});
    setEditSourceUpdatedAt("");
    setEditBaselineVerifications({});
    setEditOtp(emptyProfileEditOtp);
    setEditing(false);
    setError("");
    setNotice("");
  }

  async function startProfileEdit() {
    if (!editing || saving) return;
    setSaving(true);
    setError("");
    let response: Response | undefined;
    try {
      response = await fetch("/api/connect/profile-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          accountId: account.id,
          profileType: account.profileType,
          mobileCountryCode: values.mobileCountryCode,
          mobileNumber: values.mobileNumber,
          hasPfUan: pfAnswer,
          hasEsiNo: esiAnswer,
          sourceUpdatedAt: editSourceUpdatedAt,
          payload: editablePayload()
        })
      });
      const payload = await readJsonResponse<{
        requestId: string;
        mobileChanged?: boolean;
        currentMasked?: string;
        newMasked?: string;
      }>(response, "Unable to start profile verification. Please try again.");
      setEditOtp({
        open: true,
        requestId: payload.requestId,
        leg: "current",
        currentCode: "",
        newCode: "",
        newOtpSent: false,
        mobileChanged: Boolean(payload.mobileChanged),
        currentMasked: payload.currentMasked || "your current mobile number",
        newMasked: payload.newMasked || "",
        busy: false,
        error: "",
        message: ""
      });
    } catch (reason) {
      // If the request may have reached OTP delivery, its request-bound
      // verification rows may have been consumed or rolled back. Force only
      // changed identity fields to verify again; saved baseline tags remain.
      if (!response || response.status >= 500) setVerifications({});
      setError(userFacingError(reason, "Unable to start profile verification. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  async function commitProfileEdit(requestId: string) {
    const response = await fetch("/api/connect/profile-edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "commit", requestId })
    });
    const payload = await readJsonResponse<{ sessionRevoked?: boolean }>(response, "Unable to save profile changes.");
    if (payload.sessionRevoked) {
      window.location.assign("/?profileUpdated=1");
      return;
    }
    window.location.reload();
  }

  async function verifyProfileEditOtp() {
    const code = editOtp.leg === "current" ? editOtp.currentCode : editOtp.newCode;
    if (editOtp.busy || !/^\d{6}$/.test(code) || (editOtp.leg === "new" && !editOtp.newOtpSent)) {
      if (!/^\d{6}$/.test(code)) {
        setEditOtp((current) => ({
          ...current,
          error: `Enter the 6 digit ${current.leg === "current" ? "current-number" : "new-number"} OTP.`
        }));
      }
      return;
    }
    setEditOtp((current) => ({ ...current, busy: true, error: "", message: "" }));
    try {
      const response = await fetch("/api/connect/profile-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", requestId: editOtp.requestId, leg: editOtp.leg, otp: code })
      });
      const payload = await readJsonResponse<{
        nextLeg?: "new" | "commit";
        otpSent?: boolean;
        warning?: string;
      }>(response, "OTP verification failed. Please try again.");
      if (payload.nextLeg === "new") {
        setEditOtp((current) => ({
          ...current,
          leg: "new",
          currentCode: "",
          newCode: "",
          newOtpSent: payload.otpSent !== false,
          busy: false,
          error: payload.otpSent === false ? (payload.warning || "Current number verified, but the new OTP could not be sent. Tap Resend OTP.") : "",
          message: ""
        }));
        return;
      }
      await commitProfileEdit(editOtp.requestId);
    } catch (reason) {
      setEditOtp((current) => ({
        ...current,
        busy: false,
        error: userFacingError(reason, "OTP verification failed. Please try again.")
      }));
    }
  }

  async function resendProfileEditOtp() {
    if (editOtp.busy) return;
    setEditOtp((current) => ({ ...current, busy: true, error: "", message: "" }));
    try {
      const response = await fetch("/api/connect/profile-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resend", requestId: editOtp.requestId, leg: editOtp.leg })
      });
      await readJsonResponse(response, "Unable to resend OTP. Please try again.");
      setEditOtp((current) => ({
        ...current,
        busy: false,
        currentCode: current.leg === "current" ? "" : current.currentCode,
        newCode: current.leg === "new" ? "" : current.newCode,
        newOtpSent: current.leg === "new" ? true : current.newOtpSent,
        message: "OTP resent."
      }));
    } catch (reason) {
      setEditOtp((current) => ({
        ...current,
        busy: false,
        error: userFacingError(reason, "Unable to resend OTP. Please try again.")
      }));
    }
  }

  async function submitProfile() {
    if (!formRef.current || saving) return;
    const validationError = registrationSubmissionError();
    if (validationError) {
      setError(validationError);
      setConfirmationOpen(false);
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      if (account.activationOnly) {
        const form = new FormData(formRef.current);
        const draftData: Record<string, string> = {};
        form.forEach((value, key) => {
          if (typeof value === "string" && key !== "profile_verification_results") draftData[key] = value;
        });
        draftData.has_pf_uan = pfAnswer;
        draftData.has_esi_no = esiAnswer;
        draftData._beta_status = "submitted";
        draftData._beta_submitted_at = new Date().toISOString();
        const staged = new FormData();
        staged.set("account_id", account.id);
        staged.set("profile_type", account.profileType);
        staged.set("draft_data", JSON.stringify(draftData));
        const currentChecks = isolatedPilot ? [] : Object.values(verifications).filter((item) => currentCheck(item.kind) === item);
        currentChecks.forEach((item) => staged.append("profile_verification_results", JSON.stringify(item)));
        for (const slot of Object.keys(draftUploadSlots)) {
          const file = form.get(slot);
          if (file instanceof File && file.size > 0) staged.set(slot, file);
        }
        await compressFormImages(staged);
        if (formFileBytes(staged) > MAX_UPLOAD_REQUEST_BYTES) throw new Error(UPLOAD_TOO_LARGE_MESSAGE);
        const response = await fetch("/api/connect/profile-draft", { method: "POST", body: staged });
        if (response.status === 413) throw new Error(UPLOAD_TOO_LARGE_MESSAGE);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to stage registration.");
        setConfirmationOpen(false);
        setNotice("Beta registration submitted for review. Your main Workforce record has not been changed.");
        await onSubmitted?.();
        return;
      }
      const data = new FormData(formRef.current);
      data.set(executive ? "executive_id" : "employee_id", account.id);
      if (executive) data.set("profile_type", account.profileType);
      const currentChecks = isolatedPilot ? [] : Object.values(verifications).filter((item) => currentCheck(item.kind) === item);
      const reviewKinds = new Set(["pan", "pan_aadhaar", "dl", "pf_uan"]);
      const manualReview = currentChecks.some((item) => reviewKinds.has(item.kind) && (!item.verified || item.manualReview));
      data.set("manual_review_required", String(manualReview));
      if (profile?.agreement) {
        data.set("agreement_accepted", String(agreementAccepted));
        data.set("agreement_id", profile.agreement.id);
        data.set("agreement_version", String(profile.agreement.version));
      }
      currentChecks.forEach((item) => data.append("profile_verification_results", JSON.stringify(item)));
      await compressFormImages(data);
      if (formFileBytes(data) > MAX_UPLOAD_REQUEST_BYTES) throw new Error(UPLOAD_TOO_LARGE_MESSAGE);
      const response = await fetch(endpoint, { method: "POST", body: data });
      if (response.status === 413) throw new Error(UPLOAD_TOO_LARGE_MESSAGE);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to save profile.");
      setProfile(payload.profile);
      setNotice("Profile saved.");
      setConfirmationOpen(false);
      if (payload.profile.profilePhotoUrl) onPhoto?.(payload.profile.profilePhotoUrl);
      await onSubmitted?.();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (reason) {
      setError(userFacingError(reason, "Unable to save profile. Please try again."));
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
      const currentChecks = isolatedPilot ? [] : Object.values(verifications).filter((item) => currentCheck(item.kind) === item);
      currentChecks.forEach((item) => data.append("profile_verification_results", JSON.stringify(item)));
      for (const slot of Object.keys(draftUploadSlots)) {
        const file = form.get(slot);
        if (file instanceof File && file.size > 0) data.set(slot, file);
      }
      await compressFormImages(data);
      if (formFileBytes(data) > MAX_UPLOAD_REQUEST_BYTES) throw new Error(UPLOAD_TOO_LARGE_MESSAGE);
      const response = await fetch("/api/connect/profile-draft", { method: "POST", body: data });
      if (response.status === 413) throw new Error(UPLOAD_TOO_LARGE_MESSAGE);
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
      setError(userFacingError(reason, "Unable to save draft. Please try again."));
    } finally {
      setDraftSaving(false);
    }
  }

  if (!profile && !error) return <Spinner />;
  if (!profile) return <div className="dx-alert error">{error}</div>;
  if (isolatedPilot && profile.betaRegistrationReady === false) return <section className="dx-main dx-beta-onboarding"><div className="dx-beta-card"><small>FIRST, GET STARTED</small><h2>Learn the role with your station buddy</h2><p>Enrol your biometric ID and spend up to 2 days learning the work. When ready, choose Continue to registration in Work setup.</p><a className="dx-beta-primary" href={`/activation?${new URLSearchParams({id:account.id,account:`${account.profileType}:${account.companyId}:${account.id}`})}`}>Open first milestone</a></div></section>;

  const supportsExit = ["employee", "user", "contractor", "field_executive", "workforce", "vendor", "worker"].includes(account.profileType);
  if (completed && supportsExit && exitOpen) {
    return <ConnectExitManagement account={account} onBack={() => setExitOpen(false)} />;
  }

  if (completed) {
    const read = profile.readOnly;
    const sections = [
      { name: executive ? "Profile details" : "Employee details", values: {
        "Full name": read.fullName,
        ...(account.activationOnly ? {} : { [executive ? "DropX ID" : "ID"]: read[executive ? "reference" : "employeeId"] }),
        [account.activationOnly ? "Biometric ID · attendance only" : "Biometric ID"]: read.biometricId,
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
      {error ? <div className="dx-alert error">{error}</div> : null}
      <div className="dx-profile-hero">
        <small>DROPX LOGISTICS</small><h1>Profile details</h1><i><UserRound /></i>
        {canEditProfile ? <button className="dx-profile-edit-button" disabled={editLoading} onClick={() => void beginProfileEdit()} type="button"><Pencil />{editLoading ? "Loading..." : "Edit profile"}</button> : null}
      </div>
      {!readOnly && !account.activationOnly ? <VerifiedProfilePhotoUpdate account={account} currentPhotoUrl={profile.profilePhotoUrl || account.profilePhotoUrl} onUpdated={(url) => {
        setProfile((current) => current ? { ...current, profilePhotoUrl: url, uploads: { ...current.uploads, photo: true }, uploadUrls: { ...current.uploadUrls, photo: url } } : current);
        onPhoto?.(url);
      }} /> : null}
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

  if (!editing && profile.agreement && !agreementGatePassed) {
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
      {options?.choices ? <select name={field} onChange={(event) => set(valueKey, event.target.value)} required={nativeFieldRequired(field, valueKey)} value={value}>
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
        required={nativeFieldRequired(field, valueKey)}
        value={value}
      />}
    </label>;
  };

  const dateField = (field: string, label: string, options?: { readOnly?: boolean; warning?: string }) => {
    if (!enabled.has(field)) return null;
    const valueKey = fieldValueKeys[field] ?? field;
    // Only the date of birth is an input to a check. Expiry dates are either
    // supplied by the check (and read-only) or typed by hand when it had none,
    // so editing one must not throw the check away.
    const verificationToClear = field === "date_of_birth" ? ["dl"] : [];
    return <ManualDateField
      key={field}
      label={label}
      name={field}
      onChange={(value) => set(valueKey, value, verificationToClear)}
      readOnly={options?.readOnly}
      required={nativeFieldRequired(field, valueKey)}
      value={values[valueKey] ?? ""}
      warning={options?.warning}
    />;
  };

  // The real <input> is visually hidden by .dx-upload's CSS, so the browser's own "file chosen"
  // text never shows — the label has to reflect the chosen file itself.
  const upload = (name: string, label: string, slot: string) => {
    if (!enabled.has(name)) return null;
    const chosen = chosenUploads[name];
    const saved = Boolean(profile.uploads[slot]);
    return <label className={`dx-upload${chosen ? " is-chosen" : ""}`}>
      <span>{label}{required.has(name) ? " *" : ""}</span>
      <input accept="image/*,.pdf" name={name} onChange={(event) => chooseUpload(name, event.target.files?.[0])} required={required.has(name) && !saved} type="file" />
      <small className="dx-upload-file">
        {chosen?.previewUrl ? <img alt="" src={chosen.previewUrl} /> : null}
        <b>{chosen ? chosen.fileName : saved ? "Uploaded" : "No file chosen"}</b>
      </small>
      <em>{chosen || saved ? "Change" : "Choose file"}</em>
    </label>;
  };

  const dlCheck = actionCheck("dl");
  const vehicleCheck = actionCheck("vehicle");
  const verifiedVehicleCheck = vehicleCheck?.verified === true;
  const panAadhaarDependency = editing && editVerificationPlan.panAadhaarDependency;
  const bankDependency = editing && editVerificationPlan.bankDependency;
  const drivingLicenseDependency = editing && editVerificationPlan.drivingLicenseDependency;
  const panPrerequisiteMissing = (!editing || editVerificationPlan.panChanged) && (!attempted("pan") || Boolean(actionCheck("pan")?.blockSubmit));
  const showHiddenPanAadhaarCheck = enabled.has("pan_number") && !enabled.has("aadhaar_number") && (panAadhaarDependency || Boolean(currentCheck("pan_aadhaar")));
  const showHiddenBankCheck = enabled.has("bank_account_no") && !enabled.has("ifsc") && (bankDependency || Boolean(currentCheck("bank")));
  const showHiddenDrivingLicenseCheck = !enabled.has("driving_license_no") && (enabled.has("date_of_birth") || enabled.has("driving_license_exp_date")) && (drivingLicenseDependency || Boolean(currentCheck("dl")));
  const drivingEnabled = showHiddenDrivingLicenseCheck || ["driving_license_no","driving_license_exp_date","vehicle_reg_no","vehicle_reg_exp_date","vehicle_insurance_exp_date","vehicle_pollution_exp_date"].some((field) => enabled.has(field));

  return <form className="dx-profile-form" onSubmit={prepareSubmit} ref={formRef}>
    {isolatedPilot ? <aside className="dx-beta-review-note"><ShieldCheck size={20}/><div><strong>Submit your details for review</strong><p>Your documents will be reviewed within this private beta. Submitting does not mark identity or bank checks as verified.</p></div></aside> : null}
    <p className="dx-company">{account.companyName}</p>
    {!readOnly && !account.activationOnly && !editing ? <VerifiedProfilePhotoUpdate account={account} currentPhotoUrl={profile.profilePhotoUrl || account.profilePhotoUrl} onUpdated={(url) => {
      setProfile((current) => current ? { ...current, profilePhotoUrl: url, uploads: { ...current.uploads, photo: true }, uploadUrls: { ...current.uploadUrls, photo: url } } : current);
      onPhoto?.(url);
    }} /> : null}
    {!editing && profile.returnRemarks && profile.status.trim().toLowerCase() === "returned" ? (
      <aside className="dx-return-notice">
        <strong>Profile returned for correction</strong>
        <p>{profile.returnRemarks}</p>
      </aside>
    ) : null}
    <ProfileSection title={executive ? "Profile details" : "Employee details"}>
      {Object.entries(profile.readOnly)
        .filter(([label]) => !editing || label !== "mobile")
        .filter(([label]) => !account.activationOnly || !["reference", "employeeId", "dropxId"].includes(label))
        .map(([label, value]) => <div className="dx-readonly" key={label}><span>{account.activationOnly && label === "biometricId" ? "Biometric ID · attendance only" : title(label)}</span><strong>{value || "-"}</strong></div>)}
      {editing ? <div className="dx-mobile-edit-fields">
        <label className="dx-field"><span>Country code *</span><select name="mobile_country_code" onChange={(event) => set("mobileCountryCode", event.target.value)} required value={values.mobileCountryCode || "91"}>{countryCodeOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}</select></label>
        <label className="dx-field"><span>Mobile number *</span><input autoComplete="tel" inputMode="numeric" maxLength={14} minLength={6} name="mobile" onChange={(event) => set("mobileNumber", event.target.value.replace(/\D/g, "").slice(0, 14))} required value={values.mobileNumber || ""} /></label>
      </div> : null}
    </ProfileSection>
    <ProfileSection title="Personal details">
      {input("gender","Gender",{ choices: ["Male","Female","Other"] })}
      {dateField("date_of_birth","Date of birth",{ warning: minimumAgeError(values.dateOfBirth) ?? "" })}
      {enabled.has("pan_number") ? <>
        <VerifyField label={`PAN${required.has("pan_number") ? " *" : ""}`} name="pan_number" onChange={(value) => set("panNumber", value, ["pan","pan_aadhaar"])} onVerify={isolatedPilot ? undefined : () => verify("pan")} running={running === "pan"} value={values.panNumber || ""} checked={attempted("pan")} verified={verified("pan")} error={verificationErrors.pan || verificationInputError("pan", values)} required={nativeFieldRequired("pan_number", "panNumber")} />
        <VerificationText checks={[actionCheck("pan")]} running={running === "pan" ? "pan" : undefined} />
      </> : null}
      {enabled.has("aadhaar_number") ? <>
        <VerifyField
          label={`Aadhaar number${required.has("aadhaar_number") ? " *" : ""}`}
          name="aadhaar_number"
          onChange={(value) => set("aadhaarNumber", value, ["pan_aadhaar"])}
          onVerify={isolatedPilot ? undefined : () => verify("pan_aadhaar")}
          running={running === "pan_aadhaar"}
          value={values.aadhaarNumber || ""}
          checked={attempted("pan_aadhaar")}
          verified={verified("pan_aadhaar")}
          disabled={!isolatedPilot && panPrerequisiteMissing}
          placeholder={!isolatedPilot && panPrerequisiteMissing ? "Verify PAN first" : undefined}
          error={verificationErrors.pan_aadhaar || verificationInputError("pan_aadhaar", values)}
          required={nativeFieldRequired("aadhaar_number", "aadhaarNumber")}
        />
        <VerificationText checks={[actionCheck("pan_aadhaar")]} running={running === "pan_aadhaar" ? "pan_aadhaar" : undefined} />
      </> : null}
      {showHiddenPanAadhaarCheck ? <>
        <VerificationAction label="PAN–Aadhaar link" onVerify={() => verify("pan_aadhaar")} running={running === "pan_aadhaar"} checked={attempted("pan_aadhaar")} verified={verified("pan_aadhaar")} disabled={panPrerequisiteMissing} error={verificationErrors.pan_aadhaar || verificationInputError("pan_aadhaar", values)} />
        <VerificationText checks={[actionCheck("pan_aadhaar")]} running={running === "pan_aadhaar" ? "pan_aadhaar" : undefined} />
      </> : null}
      {input("father_name","Father name")}
      {input("blood_group","Blood group",{ choices: bloodGroups })}
      {input("is_handicapped","Handicapped",{ choices: [{ value: "false", label: "No" }, { value: "true", label: "Yes" }] })}
    </ProfileSection>
    <ProfileSection title="Address">
      {input("address","Address")}{input("state_code","State code",{ choices: states })}{input("pincode","Pincode")}{input("landmark","Landmark")}
    </ProfileSection>
    <ProfileSection title="Bank details">
      {enabled.has("bank_account_no") ? <label className="dx-field"><span>Bank account no{required.has("bank_account_no") ? " *" : ""}</span><input maxLength={30} name="bank_account_no" onChange={(event) => set("bankAccountNo", sanitizeProfileInput("bank_account_no", event.target.value), ["bank"])} required={nativeFieldRequired("bank_account_no", "bankAccountNo")} value={values.bankAccountNo || ""} /></label> : null}
      {enabled.has("ifsc") ? <>
        <VerifyField label={`IFSC${required.has("ifsc") ? " *" : ""}`} name="ifsc" onChange={(value) => set("ifsc", value, ["bank"])} onVerify={isolatedPilot ? undefined : () => verify("bank")} running={running === "bank"} value={values.ifsc || ""} verified={verified("bank")} error={verificationErrors.bank || verificationInputError("bank", values)} required={nativeFieldRequired("ifsc", "ifsc")} />
        <VerificationText checks={[actionCheck("bank")]} running={running === "bank" ? "bank" : undefined} />
      </> : null}
      {showHiddenBankCheck ? <>
        <VerificationAction label="Bank account check" onVerify={() => verify("bank")} running={running === "bank"} checked={attempted("bank")} verified={verified("bank")} error={verificationErrors.bank || verificationInputError("bank", values)} />
        <VerificationText checks={[actionCheck("bank")]} running={running === "bank" ? "bank" : undefined} />
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
          <VerifyField label="PF UAN *" name="pf_uan" onChange={(value) => set("pfUan", value, ["pf_uan"])} onVerify={isolatedPilot ? undefined : () => verify("pf_uan")} running={running === "pf_uan"} value={values.pfUan || ""} checked={attempted("pf_uan")} verified={verified("pf_uan")} error={verificationErrors.pf_uan || verificationInputError("pf_uan", values)} required={!editing || !editOriginalValues.pfUan || editValueChanged("pfUan")} />
          <VerificationText checks={[actionCheck("pf_uan")]} running={running === "pf_uan" ? "pf_uan" : undefined} />
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
        {esiAnswer === "yes" ? <label className="dx-field"><span>ESI No *</span><input name="esi_no" onChange={(event) => set("esiNo", event.target.value)} required={!editing || !editOriginalValues.esiNo || editValueChanged("esiNo")} value={values.esiNo || ""} /></label> : null}
      </> : null}
    </ProfileSection> : null}
    {drivingEnabled ? <ProfileSection title="Driving and vehicle">
      {enabled.has("driving_license_no") ? <>
        <VerifyField label={`Driving license no${required.has("driving_license_no") ? " *" : ""}`} name="driving_license_no" onChange={(value) => set("drivingLicenseNo", value, ["dl"])} onVerify={isolatedPilot ? undefined : () => verify("dl")} running={running === "dl"} value={values.drivingLicenseNo || ""} checked={attempted("dl") && !dlCheck?.blockSubmit} verified={verified("dl")} error={verificationErrors.dl || verificationInputError("dl", values)} required={nativeFieldRequired("driving_license_no", "drivingLicenseNo")} />
        <VerificationText checks={[dlCheck]} running={running === "dl" ? "dl" : undefined} />
      </> : null}
      {showHiddenDrivingLicenseCheck ? <>
        <VerificationAction label="Driving licence check" onVerify={() => verify("dl")} running={running === "dl"} checked={attempted("dl") && !dlCheck?.blockSubmit} verified={verified("dl")} error={verificationErrors.dl || verificationInputError("dl", values)} />
        <VerificationText checks={[dlCheck]} running={running === "dl" ? "dl" : undefined} />
      </> : null}
      {dateField("driving_license_exp_date","DL expiry date",{ readOnly: Boolean(dlCheck?.expiryDate), warning: expired(values.drivingLicenseExpiry) ? "Driving licence has expired." : "" })}
      {enabled.has("vehicle_reg_no") ? <>
        <VerifyField label={`Vehicle reg no${required.has("vehicle_reg_no") ? " *" : ""}`} name="vehicle_reg_no" onChange={(value) => set("vehicleRegistrationNo", value, ["vehicle"])} onVerify={isolatedPilot ? undefined : () => verify("vehicle")} running={running === "vehicle"} value={values.vehicleRegistrationNo || ""} verified={verified("vehicle")} error={verificationErrors.vehicle || verificationInputError("vehicle", values)} required={nativeFieldRequired("vehicle_reg_no", "vehicleRegistrationNo")} />
        <VerificationText checks={[vehicleCheck]} running={running === "vehicle" ? "vehicle" : undefined} />
      </> : null}
      {dateField("vehicle_reg_exp_date","Reg expiry date",{ readOnly: verifiedVehicleCheck && Boolean(vehicleCheck?.registrationExpiryDate), warning: expired(values.registrationExpiry) ? "Vehicle registration has expired." : "" })}
      {dateField("vehicle_insurance_exp_date","Vehicle Insurance expiry",{ readOnly: verifiedVehicleCheck && Boolean(vehicleCheck?.insuranceExpiryDate), warning: expired(values.insuranceExpiry) ? "Vehicle insurance has expired." : "" })}
      {!(verifiedVehicleCheck && isPureElectricFuel(vehicleCheck?.fuelType)) ? dateField("vehicle_pollution_exp_date","Pollution expiry date",{ readOnly: verifiedVehicleCheck && Boolean(vehicleCheck?.pollutionExpiryDate), warning: expired(values.pollutionExpiry) ? "Pollution certificate has expired." : "" }) : null}
    </ProfileSection> : null}
    <ProfileSection title="Emergency contact">
      {input("emergency_contact_number","Emergency contact number")}{input("emergency_contact_name","Contact person name")}{input("emergency_contact_relation","Relation",{ choices: relations })}
    </ProfileSection>
    {!editing ? <ProfileSection title="Uploads">
      {upload("aadhaar_front","Aadhaar front","aadhaarFront")}{upload("aadhaar_back","Aadhaar back","aadhaarBack")}{upload("pan_upload","PAN upload","pan")}{upload("dl_front","DL front","dlFront")}{upload("dl_back","DL back","dlBack")}{upload("profile_photo","Photo upload","photo")}
    </ProfileSection> : null}
    {!editing && profile.agreement ? <ProfileSection title="Mandatory agreement">
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
      {editing ? <button className="dx-draft-save" disabled={saving || Boolean(running)} onClick={cancelProfileEdit} type="button">Cancel</button> : <button className="dx-draft-save" disabled={saving || draftSaving} onClick={saveDraft} type="button">
        {draftSaving ? "Saving draft..." : "Save draft"}
      </button>}
      <button className="dx-save" disabled={saving || draftSaving || (editing && Boolean(running))} type="submit">{saving ? (editing ? "Sending OTP..." : "Submitting...") : (editing ? "Verify & save" : "Submit")}</button>
    </div>
    {!editing && confirmationOpen ? (
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
    {editing && editOtp.open ? (
      <div className="dx-submit-confirmation-backdrop" role="presentation">
        <section aria-labelledby="dx-profile-edit-otp-title" aria-modal="true" className="dx-submit-confirmation dx-profile-edit-otp" role="dialog">
          <div className="dx-profile-edit-otp-icon"><LockKeyhole /></div>
          <h2 id="dx-profile-edit-otp-title">Verify mobile {editOtp.mobileChanged ? "numbers" : "number"}</h2>
          <div className="dx-profile-edit-otp-fields">
            <div className="dx-field dx-profile-edit-otp-field">
              <label htmlFor="dx-profile-edit-current-otp">Current number OTP <small>{editOtp.currentMasked}</small></label>
              <div className="dx-profile-edit-otp-control">
                <input
                  aria-describedby={editOtp.error && editOtp.leg === "current" ? "dx-profile-edit-otp-error" : undefined}
                  autoComplete={editOtp.leg === "current" ? "one-time-code" : "off"}
                  autoFocus
                  disabled={editOtp.busy || editOtp.leg !== "current"}
                  id="dx-profile-edit-current-otp"
                  inputMode="numeric"
                  maxLength={6}
                  name="current_mobile_otp"
                  onChange={(event) => setEditOtp((current) => ({
                    ...current,
                    currentCode: event.target.value.replace(/\D/g, "").slice(0, 6),
                    error: "",
                    message: ""
                  }))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void verifyProfileEditOtp();
                    }
                  }}
                  pattern="[0-9]*"
                  value={editOtp.currentCode}
                />
                {editOtp.leg === "current" ? (
                  <button
                    aria-label={`Resend OTP to current number ${editOtp.currentMasked}`}
                    className="dx-profile-edit-resend"
                    disabled={editOtp.busy}
                    onClick={resendProfileEditOtp}
                    type="button"
                  >Resend</button>
                ) : (
                  <span className="dx-profile-edit-otp-verified" role="status"><BadgeCheck aria-hidden="true" />Verified</span>
                )}
              </div>
            </div>
            {editOtp.mobileChanged ? (
              <div className="dx-field dx-profile-edit-otp-field">
                <label htmlFor="dx-profile-edit-new-otp">New number OTP <small>{editOtp.newMasked}</small></label>
                <div className="dx-profile-edit-otp-control">
                  <input
                    aria-describedby={editOtp.leg === "current"
                      ? "dx-profile-edit-new-otp-wait"
                      : editOtp.error ? "dx-profile-edit-otp-error" : undefined}
                    autoComplete={editOtp.leg === "new" ? "one-time-code" : "off"}
                    disabled={editOtp.busy || editOtp.leg !== "new" || !editOtp.newOtpSent}
                    id="dx-profile-edit-new-otp"
                    inputMode="numeric"
                    maxLength={6}
                    name="new_mobile_otp"
                    onChange={(event) => setEditOtp((current) => ({
                      ...current,
                      newCode: event.target.value.replace(/\D/g, "").slice(0, 6),
                      error: "",
                      message: ""
                    }))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void verifyProfileEditOtp();
                      }
                    }}
                    pattern="[0-9]*"
                    ref={newOtpInputRef}
                    value={editOtp.newCode}
                  />
                  {editOtp.leg === "new" ? (
                    <button
                      aria-label={`Resend OTP to new number ${editOtp.newMasked}`}
                      className="dx-profile-edit-resend"
                      disabled={editOtp.busy}
                      onClick={resendProfileEditOtp}
                      type="button"
                    >Resend</button>
                  ) : null}
                </div>
                {editOtp.leg === "current" ? <span className="sr-only" id="dx-profile-edit-new-otp-wait">Verify the current number first.</span> : null}
              </div>
            ) : null}
          </div>
          {editOtp.message ? <div aria-live="polite" className="dx-alert success" role="status">{editOtp.message}</div> : null}
          {editOtp.error ? <div className="dx-alert error" id="dx-profile-edit-otp-error" role="alert">{editOtp.error}</div> : null}
          <div>
            <button className="dx-confirm-cancel" disabled={editOtp.busy} onClick={() => setEditOtp(emptyProfileEditOtp)} type="button">Cancel</button>
            <button
              className="dx-confirm-submit"
              disabled={editOtp.busy
                || (editOtp.leg === "current" ? editOtp.currentCode.length !== 6 : editOtp.newCode.length !== 6 || !editOtp.newOtpSent)}
              onClick={verifyProfileEditOtp}
              type="button"
            >
              {editOtp.busy
                ? <><span className="dx-button-spinner" aria-hidden="true" />Verifying...</>
                : editOtp.mobileChanged && editOtp.leg === "current" ? "Verify current" : "Verify & save"}
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

function verificationLabel(kind: string) {
  return ({
    pan: "PAN",
    pan_aadhaar: "PAN Aadhaar link",
    bank: "Bank",
    pf_uan: "PF UAN",
    dl: "DL",
    vehicle: "vehicle details"
  } as Record<string, string>)[kind] ?? "verification";
}

function VerificationText({ checks, running }: { checks: Array<Verification | undefined>; running?: string }) {
  const check = checks.find(Boolean);
  if (running) {
    return <div className="dx-verification pending">
      <i className="mini-spin" aria-hidden="true" />
      <span><strong>Verifying {verificationLabel(running)}</strong></span>
    </div>;
  }
  if (!check) return null;

  const holder = check.name || check.accountName || check.ownerName;
  const status = check.message || (check.verified ? "Verified." : "Verification failed.");
  // Vehicle and bank checks never block registration, so an unverified one is a notice, not a failure.
  const advisory = check.manualReview || (!check.verified && !check.blockSubmit && ["vehicle", "bank"].includes(check.kind));
  const tone = check.verified ? "ok" : advisory ? "review" : "fail";
  const Icon = check.verified ? ShieldCheck : advisory ? TriangleAlert : CircleX;
  const identityMismatch = ["pan", "dl", "pf_uan"].includes(check.kind) && !check.verified && Boolean(holder);
  const fallbackLabel = check.verified
    ? `${verificationLabel(check.kind)} checked`
    : advisory
      ? `${verificationLabel(check.kind)} not verified`
      : `${verificationLabel(check.kind)} verification failed`;
  const label = check.kind === "bank" && (check.verified || check.accountName || check.name)
    ? `Beneficiary: ${check.accountName || check.name || "Name not returned"}`
    : check.kind === "pan_aadhaar"
      ? status
    : check.kind === "vehicle" && holder
      ? `RC owner: ${holder}`
      : holder || fallbackLabel;
  const detail = check.kind === "vehicle" && check.fuelType
    ? `${check.fuelType}${status ? ` · ${status}` : ""}`
    : holder || check.message ? status : undefined;

  return <div className={`dx-verification ${tone}${identityMismatch ? " mismatch" : ""}`}>
    <Icon />
    <span><strong>{label}</strong>{detail && detail !== label ? <small>{detail}</small> : null}</span>
  </div>;
}
