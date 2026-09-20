import { createHash } from "crypto";
import { userFacingError } from "@/lib/user-facing-error";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { connectSessionCookieName, findConnectAccounts } from "../../../../src/lib/connect-auth";
import {
  deleteProfileDraft,
  draftVerificationValues,
  loadProfileDraft
} from "../../../../src/lib/profile-drafts";
import { saveProfileVerifications } from "../../../../src/lib/profile-verifications";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";
import { loadWorkforceCategoryRules } from "../../../../src/lib/workforce-category-rules";
import { assertMinimumProfileAge } from "../../../../src/lib/profile-age";
import { createProfileSubmittedNotification } from "../../../../src/lib/app-notifications";

type EmployeeProfileRow = {
  id: string;
  company_id: string;
  employee_code: string | null;
  biometric_id?: string | null;
  full_name: string;
  mobile_country_code: string | null;
  mobile: string;
  email: string | null;
  date_of_join: string | null;
  gender: string | null;
  date_of_birth: string | null;
  aadhaar_number: string | null;
  pan_number: string | null;
  eshram_uan?: string | null;
  is_handicapped?: boolean | null;
  address: string | null;
  state: string | null;
  pincode: string | null;
  landmark: string | null;
  state_code: string | null;
  father_name: string | null;
  blood_group: string | null;
  bank_account_no: string | null;
  ifsc: string | null;
  statutory_applicability: string[] | null;
  pf_uan?: string | null;
  pf_account_no?: string | null;
  esi_no?: string | null;
  driving_license_no?: string | null;
  driving_license_exp_date?: string | null;
  vehicle_reg_no?: string | null;
  vehicle_reg_exp_date?: string | null;
  vehicle_insurance_exp_date?: string | null;
  vehicle_pollution_exp_date?: string | null;
  emergency_contact_name: string | null;
  emergency_contact_number: string | null;
  emergency_contact_relation: string | null;
  profile_photo_path: string | null;
  aadhaar_front_path: string | null;
  aadhaar_back_path: string | null;
  pan_upload_path: string | null;
  dl_front_path?: string | null;
  dl_back_path?: string | null;
  profile_completion_status: string | null;
  profile_return_remarks?: string | null;
  stations?: { station_code: string | null; station_name: string | null } | { station_code: string | null; station_name: string | null }[] | null;
  designations?: { code: string | null; name: string | null; profile_field_rules?: unknown } | { code: string | null; name: string | null; profile_field_rules?: unknown }[] | null;
};

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function cleanText(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || null;
}

function cleanDigits(value: FormDataEntryValue | null) {
  const text = String(value ?? "").replace(/\D/g, "");
  return text || null;
}

function formatDisplayDate(value: string | null) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value ?? "-";
}

function normalizeDate(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const displayMatch = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const isoValue = isoMatch ? text : displayMatch ? `${displayMatch[3]}-${displayMatch[2]}-${displayMatch[1]}` : null;
  if (!isoValue) throw new Error("Enter date as dd/mm/yyyy.");
  const [year, month, day] = isoValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("Enter a valid date.");
  }
  return isoValue;
}

function normalizeAadhaar(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^\d{12}$/.test(text)) throw new Error("Aadhaar number must be exactly 12 digits.");
  return text;
}

function normalizePan(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) return null;
  if (!/^[A-Z0-9]{10}$/.test(text)) {
    throw new Error("PAN must contain exactly 10 letters or digits.");
  }
  return text;
}

function normalizeAlphaNum(value: FormDataEntryValue | null, label: string) {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) return null;
  if (!/^[A-Z0-9]+$/.test(text)) throw new Error(`${label} can contain only letters and numbers.`);
  return text;
}

function normalizeAlphaNumLength(
  value: FormDataEntryValue | null,
  label: string,
  minLength: number,
  maxLength: number
) {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) return null;
  if (!/^[A-Z0-9]+$/.test(text) || text.length < minLength || text.length > maxLength) {
    const length = minLength === maxLength ? `exactly ${minLength}` : `${minLength} to ${maxLength}`;
    throw new Error(`${label} must contain ${length} letters or digits.`);
  }
  return text;
}

function normalizeDigitsLength(
  value: FormDataEntryValue | null,
  label: string,
  minLength: number,
  maxLength: number
) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^\d+$/.test(text) || text.length < minLength || text.length > maxLength) {
    const length = minLength === maxLength ? `exactly ${minLength}` : `${minLength} to ${maxLength}`;
    throw new Error(`${label} must contain ${length} digits.`);
  }
  return text;
}

function fileExt(name: string) {
  const ext = name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext ? `.${ext}` : "";
}

async function loadSessionAccounts() {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const token = cookies().get(connectSessionCookieName)?.value;
  if (!token) throw new Error("Connect session expired. Please log in again.");
  const sessionHash = createHash("sha256").update(token).digest("hex");
  const sessionResult = await supabaseAdmin
    .from("connect_login_sessions")
    .select("id, country_code, mobile_number, expires_at, revoked_at")
    .eq("session_hash", sessionHash)
    .maybeSingle();
  if (sessionResult.error) throw new Error(sessionResult.error.message);
  const session = sessionResult.data;
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() < Date.now()) {
    cookies().delete(connectSessionCookieName);
    throw new Error("Connect session expired. Please log in again.");
  }
  return findConnectAccounts(session.country_code, session.mobile_number);
}

async function requireEmployeeAccess(employeeId: string) {
  const accounts = await loadSessionAccounts();
  const account = accounts.find((item) => item.profileType === "employee" && item.id === employeeId);
  if (!account) throw new Error("Employee profile is not available for this login.");
  return account;
}

async function loadEmployee(employeeId: string, companyId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const result = await supabaseAdmin
    .from("employees")
    .select("id, company_id, employee_code, biometric_id, full_name, mobile_country_code, mobile, email, date_of_join, gender, date_of_birth, aadhaar_number, pan_number, eshram_uan, is_handicapped, address, state, pincode, landmark, state_code, father_name, blood_group, bank_account_no, ifsc, statutory_applicability, pf_uan, pf_account_no, esi_no, driving_license_no, driving_license_exp_date, vehicle_reg_no, vehicle_reg_exp_date, vehicle_insurance_exp_date, vehicle_pollution_exp_date, emergency_contact_name, emergency_contact_number, emergency_contact_relation, profile_photo_path, aadhaar_front_path, aadhaar_back_path, pan_upload_path, dl_front_path, dl_back_path, profile_completion_status, profile_return_remarks, stations (station_code, station_name), designations (code, name, profile_field_rules)")
    .eq("id", employeeId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (result.error && /pf_uan|esi_no|column/i.test(result.error.message)) {
    const fallbackResult = await supabaseAdmin
      .from("employees")
      .select("id, company_id, employee_code, biometric_id, full_name, mobile_country_code, mobile, email, date_of_join, gender, date_of_birth, aadhaar_number, pan_number, address, state, pincode, landmark, state_code, father_name, blood_group, bank_account_no, ifsc, statutory_applicability, emergency_contact_name, emergency_contact_number, emergency_contact_relation, profile_photo_path, aadhaar_front_path, aadhaar_back_path, pan_upload_path, profile_completion_status, profile_return_remarks, stations (station_code, station_name), designations (code, name)")
      .eq("id", employeeId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (fallbackResult.error) throw new Error(fallbackResult.error.message);
    if (!fallbackResult.data) throw new Error("Employee profile was not found.");
    return { ...fallbackResult.data, pf_uan: null, pf_account_no: null, esi_no: null } as EmployeeProfileRow;
  }
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Employee profile was not found.");
  return result.data as EmployeeProfileRow;
}

async function signedProfileUrl(path: string | null) {
  if (!supabaseAdmin || !path) return "";
  const result = await supabaseAdmin.storage
    .from("employee-profile-documents")
    .createSignedUrl(path, 60 * 60);
  return result.data?.signedUrl ?? "";
}

async function serializeEmployee(row: EmployeeProfileRow) {
  const station = firstRelation(row.stations);
  const designation = firstRelation(row.designations);
  const fieldRules = (await loadWorkforceCategoryRules(
    row.company_id,
    "employees",
    designation?.profile_field_rules,
    "employees"
  )).dropx_one;
  return {
    id: row.id,
    readOnly: {
      employeeId: row.employee_code ?? "-",
      biometricId: row.biometric_id ?? "-",
      fullName: row.full_name,
      email: row.email ?? "-",
      location: station?.station_code ?? "-",
      designation: designation?.name ?? designation?.code ?? "-",
      dateOfJoin: formatDisplayDate(row.date_of_join),
      mobile: `+${row.mobile_country_code ?? "91"} ${row.mobile}`
    },
    editable: {
      gender: row.gender ?? "",
      dateOfBirth: formatDisplayDate(row.date_of_birth) === "-" ? "" : formatDisplayDate(row.date_of_birth),
      aadhaarNumber: row.aadhaar_number ?? "",
      panNumber: row.pan_number ?? "",
      eshramUan: row.eshram_uan ?? "",
      isHandicapped: typeof row.is_handicapped === "boolean" ? String(row.is_handicapped) : "",
      address: row.address ?? "",
      state: row.state ?? "",
      pincode: row.pincode ?? "",
      landmark: row.landmark ?? "",
      stateCode: row.state_code ?? "",
      fatherName: row.father_name ?? "",
      bloodGroup: row.blood_group ?? "",
      bankAccountNo: row.bank_account_no ?? "",
      ifsc: row.ifsc ?? "",
      pfUan: row.pf_uan ?? "",
      pfAccountNo: row.pf_account_no ?? "",
      esiNo: row.esi_no ?? "",
      drivingLicenseNo: row.driving_license_no ?? "",
      drivingLicenseExpiry: formatDisplayDate(row.driving_license_exp_date ?? null) === "-" ? "" : formatDisplayDate(row.driving_license_exp_date ?? null),
      vehicleRegistrationNo: row.vehicle_reg_no ?? "",
      registrationExpiry: formatDisplayDate(row.vehicle_reg_exp_date ?? null) === "-" ? "" : formatDisplayDate(row.vehicle_reg_exp_date ?? null),
      insuranceExpiry: formatDisplayDate(row.vehicle_insurance_exp_date ?? null) === "-" ? "" : formatDisplayDate(row.vehicle_insurance_exp_date ?? null),
      pollutionExpiry: formatDisplayDate(row.vehicle_pollution_exp_date ?? null) === "-" ? "" : formatDisplayDate(row.vehicle_pollution_exp_date ?? null),
      emergencyContactName: row.emergency_contact_name ?? "",
      emergencyContactNumber: row.emergency_contact_number ?? "",
      emergencyContactRelation: row.emergency_contact_relation ?? ""
    },
    statutoryApplicability: row.statutory_applicability ?? [],
    fieldRules,
    uploads: {
      aadhaarFront: Boolean(row.aadhaar_front_path),
      aadhaarBack: Boolean(row.aadhaar_back_path),
      pan: Boolean(row.pan_upload_path),
      dlFront: Boolean(row.dl_front_path),
      dlBack: Boolean(row.dl_back_path),
      photo: Boolean(row.profile_photo_path)
    },
    uploadUrls: {
      aadhaarFront: await signedProfileUrl(row.aadhaar_front_path),
      aadhaarBack: await signedProfileUrl(row.aadhaar_back_path),
      pan: await signedProfileUrl(row.pan_upload_path),
      dlFront: await signedProfileUrl(row.dl_front_path ?? null),
      dlBack: await signedProfileUrl(row.dl_back_path ?? null),
      photo: await signedProfileUrl(row.profile_photo_path),
      profilePhoto: await signedProfileUrl(row.profile_photo_path)
    },
    profilePhotoUrl: await signedProfileUrl(row.profile_photo_path),
    status: row.profile_completion_status ?? "pending",
    returnRemarks: row.profile_return_remarks ?? ""
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const employeeId = url.searchParams.get("employeeId") ?? "";
    const account = await requireEmployeeAccess(employeeId);
    const employee = await loadEmployee(account.id, account.companyId);
    return NextResponse.json({ ok: true, profile: await serializeEmployee(employee) });
  } catch (error) {
    return NextResponse.json({ error: userFacingError(error, "Unable to load profile.") }, { status: 400 });
  }
}

async function uploadProfileFile(file: FormDataEntryValue | null, companyId: string, employeeId: string, slot: string) {
  if (!supabaseAdmin || !(file instanceof File) || file.size === 0) return null;
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${companyId}/${employeeId}/${slot}-${Date.now()}${fileExt(safeName)}`;
  const uploadResult = await supabaseAdmin.storage
    .from("employee-profile-documents")
    .upload(path, Buffer.from(await file.arrayBuffer()), {
      contentType: file.type || "application/octet-stream",
      upsert: true
    });
  if (uploadResult.error) throw new Error(uploadResult.error.message);
  return path;
}

export async function POST(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const formData = await request.formData();
    const employeeId = String(formData.get("employee_id") ?? "");
    const account = await requireEmployeeAccess(employeeId);
    const currentEmployee = await loadEmployee(account.id, account.companyId);
    const currentStatus = String(currentEmployee.profile_completion_status ?? "pending").trim().toLowerCase();
    if (!["pending", "returned"].includes(currentStatus)) {
      throw new Error("Profile cannot be edited after submission.");
    }
    const draft = await loadProfileDraft({
      accountId: account.id,
      companyId: account.companyId,
      profileType: "employee"
    });
    const manualReviewRequired = String(formData.get("manual_review_required") ?? "") === "true";
    const dateOfBirth = normalizeDate(formData.get("date_of_birth"));
    assertMinimumProfileAge(dateOfBirth);

    const uploads = await Promise.all([
      uploadProfileFile(formData.get("aadhaar_front"), account.companyId, account.id, "aadhaar-front"),
      uploadProfileFile(formData.get("aadhaar_back"), account.companyId, account.id, "aadhaar-back"),
      uploadProfileFile(formData.get("pan_upload"), account.companyId, account.id, "pan"),
      uploadProfileFile(formData.get("dl_front"), account.companyId, account.id, "dl-front"),
      uploadProfileFile(formData.get("dl_back"), account.companyId, account.id, "dl-back"),
      uploadProfileFile(formData.get("profile_photo"), account.companyId, account.id, "photo")
    ]);

    const updatePayload: Record<string, unknown> = {
      gender: cleanText(formData.get("gender")),
      date_of_birth: dateOfBirth,
      aadhaar_number: normalizeAadhaar(formData.get("aadhaar_number")),
      pan_number: normalizePan(formData.get("pan_number")),
      eshram_uan: normalizeDigitsLength(formData.get("eshram_uan"), "eShram UAN", 12, 12),
      is_handicapped: cleanText(formData.get("is_handicapped")) === null ? null : cleanText(formData.get("is_handicapped")) === "true",
      address: cleanText(formData.get("address")),
      pincode: normalizeDigitsLength(formData.get("pincode"), "Pincode", 6, 6),
      landmark: cleanText(formData.get("landmark")),
      state_code: cleanText(formData.get("state_code"))?.toUpperCase() ?? null,
      father_name: cleanText(formData.get("father_name")),
      blood_group: cleanText(formData.get("blood_group")),
      bank_account_no: normalizeAlphaNumLength(formData.get("bank_account_no"), "Bank account number", 4, 30),
      ifsc: normalizeAlphaNumLength(formData.get("ifsc"), "IFSC", 11, 11),
      emergency_contact_name: cleanText(formData.get("emergency_contact_name")),
      emergency_contact_number: normalizeDigitsLength(formData.get("emergency_contact_number"), "Emergency contact number", 4, 30),
      emergency_contact_relation: cleanText(formData.get("emergency_contact_relation")),
      driving_license_no: normalizeAlphaNumLength(formData.get("driving_license_no"), "Driving license number", 4, 30),
      driving_license_exp_date: normalizeDate(formData.get("driving_license_exp_date")),
      vehicle_reg_no: normalizeAlphaNumLength(formData.get("vehicle_reg_no"), "Vehicle registration number", 4, 30),
      vehicle_reg_exp_date: normalizeDate(formData.get("vehicle_reg_exp_date")),
      vehicle_insurance_exp_date: normalizeDate(formData.get("vehicle_insurance_exp_date")),
      vehicle_pollution_exp_date: normalizeDate(formData.get("vehicle_pollution_exp_date")),
      profile_completion_status: manualReviewRequired ? "under_review" : "active",
      profile_return_remarks: null,
      profile_returned_at: null,
      profile_completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const pfUan = normalizeDigitsLength(formData.get("pf_uan"), "PF UAN", 12, 12);
    const pfAccountNo = normalizeAlphaNum(formData.get("pf_account_no"), "PF Account No");
    const esiNo = normalizeAlphaNum(formData.get("esi_no"), "ESI No");
    if (pfUan) updatePayload.pf_uan = pfUan;
    if (pfAccountNo) updatePayload.pf_account_no = pfAccountNo;
    if (esiNo) updatePayload.esi_no = esiNo;
    const [
      uploadedAadhaarFrontPath,
      uploadedAadhaarBackPath,
      uploadedPanPath,
      uploadedDlFrontPath,
      uploadedDlBackPath,
      uploadedProfilePhotoPath
    ] = uploads;
    const aadhaarFrontPath = uploadedAadhaarFrontPath ?? draft?.filePaths.aadhaar_front ?? null;
    const aadhaarBackPath = uploadedAadhaarBackPath ?? draft?.filePaths.aadhaar_back ?? null;
    const panUploadPath = uploadedPanPath ?? draft?.filePaths.pan_upload ?? null;
    const dlFrontPath = uploadedDlFrontPath ?? draft?.filePaths.dl_front ?? null;
    const dlBackPath = uploadedDlBackPath ?? draft?.filePaths.dl_back ?? null;
    const profilePhotoPath = uploadedProfilePhotoPath ?? draft?.filePaths.profile_photo ?? null;
    if (aadhaarFrontPath) updatePayload.aadhaar_front_path = aadhaarFrontPath;
    if (aadhaarBackPath) updatePayload.aadhaar_back_path = aadhaarBackPath;
    if (panUploadPath) updatePayload.pan_upload_path = panUploadPath;
    if (dlFrontPath) updatePayload.dl_front_path = dlFrontPath;
    if (dlBackPath) updatePayload.dl_back_path = dlBackPath;
    if (profilePhotoPath) updatePayload.profile_photo_path = profilePhotoPath;

    const updateResult = await supabaseAdmin
      .from("employees")
      .update(updatePayload)
      .eq("id", account.id)
      .eq("company_id", account.companyId);
    if (updateResult.error) throw new Error(updateResult.error.message);

    const verificationValues = formData.getAll("profile_verification_results");
    await saveProfileVerifications({
      accountId: account.id,
      companyId: account.companyId,
      profileType: "employee",
      values: verificationValues.length ? verificationValues : draftVerificationValues(draft)
    });

    const employee = await loadEmployee(account.id, account.companyId);
    await deleteProfileDraft({
      accountId: account.id,
      companyId: account.companyId,
      profileType: "employee"
    });
    const obsoleteDraftPaths = [
      uploadedAadhaarFrontPath ? draft?.filePaths.aadhaar_front : null,
      uploadedAadhaarBackPath ? draft?.filePaths.aadhaar_back : null,
      uploadedPanPath ? draft?.filePaths.pan_upload : null,
      uploadedDlFrontPath ? draft?.filePaths.dl_front : null,
      uploadedDlBackPath ? draft?.filePaths.dl_back : null,
      uploadedProfilePhotoPath ? draft?.filePaths.profile_photo : null
    ].filter((path): path is string => Boolean(path));
    if (obsoleteDraftPaths.length) {
      await supabaseAdmin.storage.from("employee-profile-documents").remove(obsoleteDraftPaths);
    }
    await createProfileSubmittedNotification({
      accountId: account.id,
      companyId: account.companyId,
      profileType: "employee",
      sourceKey: `${account.id}:${new Date().toISOString()}`
    });
    return NextResponse.json({ ok: true, profile: await serializeEmployee(employee), notice: "Profile saved successfully." });
  } catch (error) {
    return NextResponse.json({ error: userFacingError(error, "Unable to save profile.") }, { status: 400 });
  }
}
