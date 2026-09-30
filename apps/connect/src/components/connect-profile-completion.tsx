"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { compressFormImages, formFileBytes, MAX_UPLOAD_REQUEST_BYTES, UPLOAD_TOO_LARGE_MESSAGE } from "../lib/compress-form-images";

type ConnectAccount = {
  id: string;
  companyId: string;
  profileType: string;
  name: string | null;
  email: string | null;
  reference: string | null;
  role: string | null;
  status?: string | null;
  companyName: string;
  label: string;
};

type ProfilePayload = {
  readOnly: {
    employeeId: string;
    biometricId?: string;
    fullName: string;
    email: string;
    location: string;
    designation: string;
    dateOfJoin: string;
    mobile: string;
  };
  editable: Record<string, string>;
  statutoryApplicability: string[];
  fieldRules?: { enabled?: string[]; required?: string[] };
  uploads: {
    aadhaarFront: boolean;
    aadhaarBack: boolean;
    pan: boolean;
    photo: boolean;
  };
  status: string;
};

const bloodGroups = ["", "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const relations = ["", "Parent", "Spouse", "Child", "Other Relative", "Friend", "Other"];
const genders = ["", "Male", "Female", "Other"];
const stateCodes = [
  "AN", "AP", "AR", "AS", "BR", "CG", "CH", "DD", "DL", "DN", "GA", "GJ", "HP", "HR", "JH", "JK", "KA", "KL", "LA", "LD", "MH", "ML", "MN", "MP", "MZ", "NL", "OD", "PB", "PY", "RJ", "SK", "TN", "TR", "TS", "UK", "UP", "WB"
];

function FieldValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="connect-readonly-field">
      <span>{label}</span>
      <strong>{value || "-"}</strong>
    </div>
  );
}

function RequiredMark() {
  return <span className="connect-required">*</span>;
}

function displayToIsoDate(value: string) {
  const text = value.trim();
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return "";
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm}-${dd}`;
}

function isoToDisplayDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function formatDateInput(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

function DateInput({ defaultValue, name }: { defaultValue: string; name: string }) {
  const initialValue = isoToDisplayDate(defaultValue);
  const [value, setValue] = useState(initialValue);
  const pickerRef = useRef<HTMLInputElement>(null);
  const openPicker = () => {
    const picker = pickerRef.current;
    if (!picker) return;
    if (typeof picker.showPicker === "function") {
      picker.showPicker();
      return;
    }
    picker.click();
  };
  return (
    <div className="connect-date-input">
      <input
        inputMode="numeric"
        maxLength={10}
        name={name}
        onChange={(event) => setValue(formatDateInput(event.target.value))}
        pattern="\d{2}/\d{2}/\d{4}"
        placeholder="dd/mm/yyyy"
        required
        title="Enter date as dd/mm/yyyy"
        type="text"
        value={value}
      />
      <button aria-label="Pick date" className="connect-calendar-button" onClick={openPicker} type="button">
        <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20">
          <path d="M8 2v4M16 2v4M3 10h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
        </svg>
      </button>
      <input
        aria-label="Pick date"
        className="connect-date-native"
        onChange={(event) => setValue(isoToDisplayDate(event.target.value))}
        ref={pickerRef}
        tabIndex={-1}
        type="date"
        value={displayToIsoDate(value)}
      />
    </div>
  );
}

export function ConnectProfileCompletion({
  account,
  onBack,
  onLogout
}: {
  account: ConnectAccount;
  onBack: () => void;
  onLogout: () => void;
}) {
  const [profile, setProfile] = useState<ProfilePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pfAnswer, setPfAnswer] = useState("");
  const [esiAnswer, setEsiAnswer] = useState("");

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    fetch(`/api/connect/profile?employeeId=${encodeURIComponent(account.id)}`)
      .then((response) => response.json().then((payload) => ({ response, payload })))
      .then(({ response, payload }: { response: Response; payload: { profile?: ProfilePayload; error?: string } }) => {
        if (!mounted) return;
        if (!response.ok) throw new Error(payload.error || "Unable to load profile.");
        setProfile(payload.profile ?? null);
        setPfAnswer(payload.profile?.editable.pfUan ? "yes" : "");
        setEsiAnswer(payload.profile?.editable.esiNo ? "yes" : "");
      })
      .catch((loadError) => {
        if (mounted) setError(loadError instanceof Error ? loadError.message : "Unable to load profile.");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [account.id]);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const formData = new FormData(event.currentTarget);
      const aadhaarNumber = String(formData.get("aadhaar_number") ?? "").trim();
      const panNumber = String(formData.get("pan_number") ?? "").trim().toUpperCase();
      if (aadhaarNumber && !/^\d{12}$/.test(aadhaarNumber)) {
        throw new Error("Aadhaar number must be exactly 12 digits.");
      }
      if (panNumber && !/^[A-Z]{3}P[A-Z][0-9]{4}[A-Z]$/.test(panNumber)) {
        throw new Error("PAN must be 10 characters and the 4th character must be P.");
      }
      const currentStatutory = profile?.statutoryApplicability ?? [];
      if (currentStatutory.includes("pf") && !formData.get("has_pf_uan")) {
        throw new Error("Please select whether you have PF UAN.");
      }
      if (currentStatutory.includes("esi") && !formData.get("has_esi_no")) {
        throw new Error("Please select whether you have ESI No.");
      }
      const pfUan = String(formData.get("pf_uan") ?? "").trim();
      const pfAccountNo = String(formData.get("pf_account_no") ?? "").trim();
      const esiNo = String(formData.get("esi_no") ?? "").trim();
      const bankAccountNo = String(formData.get("bank_account_no") ?? "").trim();
      if (formData.get("has_pf_uan") === "yes" && !pfUan) {
        throw new Error("Enter PF UAN.");
      }
      if (formData.get("has_esi_no") === "yes" && !esiNo) {
        throw new Error("Enter ESI No.");
      }
      if (pfUan && !/^[A-Za-z0-9]+$/.test(pfUan)) {
        throw new Error("PF UAN can contain only letters and numbers.");
      }
      if (pfAccountNo && !/^[A-Za-z0-9]+$/.test(pfAccountNo)) {
        throw new Error("PF Account No can contain only letters and numbers.");
      }
      if (bankAccountNo && !/^[A-Za-z0-9]+$/.test(bankAccountNo)) {
        throw new Error("Bank account no can contain only letters and numbers.");
      }
      if (esiNo && !/^[A-Za-z0-9]+$/.test(esiNo)) {
        throw new Error("ESI No can contain only letters and numbers.");
      }
      formData.set("employee_id", account.id);
      await compressFormImages(formData);
      if (formFileBytes(formData) > MAX_UPLOAD_REQUEST_BYTES) throw new Error(UPLOAD_TOO_LARGE_MESSAGE);
      const response = await fetch("/api/connect/profile", {
        method: "POST",
        body: formData
      });
      if (response.status === 413) throw new Error(UPLOAD_TOO_LARGE_MESSAGE);
      const payload = await response.json() as { profile?: ProfilePayload; error?: string; notice?: string };
      if (!response.ok) throw new Error(payload.error || "Unable to save profile.");
      if (payload.profile) setProfile(payload.profile);
      setNotice(payload.notice || "Profile saved successfully.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save profile.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="connect-login-card">
        <p className="connect-help">Loading profile...</p>
      </section>
    );
  }

  if (!profile) {
    return (
      <section className="connect-login-card">
        {error ? <div className="connect-alert error">{error}</div> : null}
        <button className="connect-secondary" onClick={onBack} type="button">Back to accounts</button>
      </section>
    );
  }

  const statutoryApplicability = profile.statutoryApplicability ?? [];
  const enabledFields = new Set(profile.fieldRules?.enabled ?? []);
  const pfAccountEnabled = enabledFields.has("pf_account_no");
  const pfAccountRequired = profile.fieldRules?.required?.includes("pf_account_no") === true;
  const showPfDetails = statutoryApplicability.includes("pf");
  const showEsiDetails = statutoryApplicability.includes("esi");

  return (
    <form className="connect-profile-card" onSubmit={saveProfile}>
      {error ? <div className="connect-alert error">{error}</div> : null}
      {notice ? <div className="connect-alert success">{notice}</div> : null}

      <div className="connect-profile-head">
        <div>
          <p>{account.companyName}</p>
          <h2>Complete your profile</h2>
          <span>{profile.status === "active" ? "Active" : profile.status === "submitted" ? "Submitted" : "Pending completion"}</span>
        </div>
      </div>

      <section className="connect-profile-section">
        <h3>Employee details</h3>
        <div className="connect-readonly-grid">
          <FieldValue label="ID" value={profile.readOnly.employeeId} />
          <FieldValue label="Biometric ID" value={profile.readOnly.biometricId ?? "-"} />
          <FieldValue label="Full name" value={profile.readOnly.fullName} />
          <FieldValue label="Email" value={profile.readOnly.email} />
          <FieldValue label="Location" value={profile.readOnly.location} />
          <FieldValue label="Designation" value={profile.readOnly.designation} />
          <FieldValue label="Date of join" value={profile.readOnly.dateOfJoin} />
          <FieldValue label="Mobile number" value={profile.readOnly.mobile} />
        </div>
      </section>

      <section className="connect-profile-section">
        <h3>Personal details</h3>
        <label>
          Gender <RequiredMark />
          <select defaultValue={profile.editable.gender} name="gender" required>
            {genders.map((gender) => <option key={gender} value={gender}>{gender || "Select gender"}</option>)}
          </select>
        </label>
        <label>
          Date of birth <RequiredMark />
          <DateInput defaultValue={profile.editable.dateOfBirth} name="date_of_birth" />
        </label>
        <label>
          Aadhaar number <RequiredMark />
          <input
            defaultValue={profile.editable.aadhaarNumber}
            inputMode="numeric"
            maxLength={12}
            name="aadhaar_number"
            pattern="\d{12}"
            required
            title="Aadhaar must be exactly 12 digits"
          />
        </label>
        <label>
          PAN <RequiredMark />
          <input
            defaultValue={profile.editable.panNumber}
            maxLength={10}
            name="pan_number"
            pattern="[A-Za-z]{3}[Pp][A-Za-z][0-9]{4}[A-Za-z]"
            required
            style={{ textTransform: "uppercase" }}
            title="PAN must be 10 characters and the 4th character must be P"
          />
        </label>
        <label>
          Father name <RequiredMark />
          <input defaultValue={profile.editable.fatherName} name="father_name" required />
        </label>
        <label>
          Blood group <RequiredMark />
          <select defaultValue={profile.editable.bloodGroup} name="blood_group" required>
            {bloodGroups.map((group) => <option key={group} value={group}>{group || "Select blood group"}</option>)}
          </select>
        </label>
      </section>

      <section className="connect-profile-section">
        <h3>Address</h3>
        <label className="connect-full-field">
          Address <RequiredMark />
          <textarea defaultValue={profile.editable.address} name="address" required rows={3} />
        </label>
        <label>
          State code <RequiredMark />
          <select defaultValue={profile.editable.stateCode} name="state_code" required>
            <option value="">Select state code</option>
            {stateCodes.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
        </label>
        <label>
          Pincode <RequiredMark />
          <input defaultValue={profile.editable.pincode} inputMode="numeric" maxLength={10} name="pincode" required />
        </label>
        <label>
          Landmark <RequiredMark />
          <input defaultValue={profile.editable.landmark} name="landmark" required />
        </label>
      </section>

      <section className="connect-profile-section">
        <h3>Bank details</h3>
        <label>
          Bank account no <RequiredMark />
          <input defaultValue={profile.editable.bankAccountNo} name="bank_account_no" pattern="[A-Za-z0-9]*" required />
        </label>
        <label>
          IFSC <RequiredMark />
          <input defaultValue={profile.editable.ifsc} maxLength={16} name="ifsc" required />
        </label>
      </section>

      {showPfDetails || showEsiDetails || pfAccountEnabled ? (
        <section className="connect-profile-section">
          <h3>Statutory details</h3>
          {showPfDetails ? (
            <div className="connect-statutory-block">
              <p>Do you have PF UAN? <RequiredMark /></p>
              <div className="connect-choice-row">
                <label><input checked={pfAnswer === "yes"} name="has_pf_uan" onChange={() => setPfAnswer("yes")} required type="radio" value="yes" /> Yes</label>
                <label><input checked={pfAnswer === "no"} name="has_pf_uan" onChange={() => setPfAnswer("no")} required type="radio" value="no" /> No</label>
              </div>
              {pfAnswer === "yes" ? (
                <label>
                  PF UAN <RequiredMark />
                  <input defaultValue={profile.editable.pfUan} name="pf_uan" pattern="[A-Za-z0-9]*" required title="Only letters and numbers are allowed" />
                </label>
              ) : null}
            </div>
          ) : null}
          {showEsiDetails ? (
            <div className="connect-statutory-block">
              <p>Do you have ESI No? <RequiredMark /></p>
              <div className="connect-choice-row">
                <label><input checked={esiAnswer === "yes"} name="has_esi_no" onChange={() => setEsiAnswer("yes")} required type="radio" value="yes" /> Yes</label>
                <label><input checked={esiAnswer === "no"} name="has_esi_no" onChange={() => setEsiAnswer("no")} required type="radio" value="no" /> No</label>
              </div>
              {esiAnswer === "yes" ? (
                <label>
                  ESI No <RequiredMark />
                  <input defaultValue={profile.editable.esiNo} name="esi_no" pattern="[A-Za-z0-9]*" required title="Only letters and numbers are allowed" />
                </label>
              ) : null}
            </div>
          ) : null}
          {pfAccountEnabled ? (
            <label>
              PF Account No {pfAccountRequired ? <RequiredMark /> : null}
              <input
                defaultValue={profile.editable.pfAccountNo}
                name="pf_account_no"
                pattern="[A-Za-z0-9]*"
                required={pfAccountRequired}
                title="Only letters and numbers are allowed"
              />
            </label>
          ) : null}
        </section>
      ) : null}

      <section className="connect-profile-section">
        <h3>Emergency contact</h3>
        <label>
          Contact person name <RequiredMark />
          <input defaultValue={profile.editable.emergencyContactName} name="emergency_contact_name" required />
        </label>
        <label>
          Emergency contact number <RequiredMark />
          <input defaultValue={profile.editable.emergencyContactNumber} inputMode="tel" maxLength={15} name="emergency_contact_number" required />
        </label>
        <label>
          Relation <RequiredMark />
          <select defaultValue={profile.editable.emergencyContactRelation} name="emergency_contact_relation" required>
            {relations.map((relation) => <option key={relation} value={relation}>{relation || "Select relation"}</option>)}
          </select>
        </label>
      </section>

      <section className="connect-profile-section">
        <h3>Uploads</h3>
        <label>
          Aadhaar front <RequiredMark /> {profile.uploads.aadhaarFront ? <span>Uploaded</span> : null}
          <input accept="image/*,.pdf" name="aadhaar_front" required={!profile.uploads.aadhaarFront} type="file" />
        </label>
        <label>
          Aadhaar back <RequiredMark /> {profile.uploads.aadhaarBack ? <span>Uploaded</span> : null}
          <input accept="image/*,.pdf" name="aadhaar_back" required={!profile.uploads.aadhaarBack} type="file" />
        </label>
        <label>
          PAN upload <RequiredMark /> {profile.uploads.pan ? <span>Uploaded</span> : null}
          <input accept="image/*,.pdf" name="pan_upload" required={!profile.uploads.pan} type="file" />
        </label>
        <label>
          Photo upload <RequiredMark /> {profile.uploads.photo ? <span>Uploaded</span> : null}
          <input accept="image/*" name="profile_photo" required={!profile.uploads.photo} type="file" />
        </label>
      </section>

      <div className="connect-profile-actions">
        <button className="connect-primary" disabled={saving} type="submit">{saving ? "Saving..." : "Save profile"}</button>
        <button className="connect-secondary" disabled={saving} onClick={onBack} type="button">Back</button>
        <button className="connect-secondary danger" disabled={saving} onClick={onLogout} type="button">Logout</button>
      </div>
    </form>
  );
}
