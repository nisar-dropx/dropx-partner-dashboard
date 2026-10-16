import { AlertTriangle, ArrowLeft, BadgeCheck, Eye, FileText, Fingerprint, Search, ShieldAlert, UserRound } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import { paginateProfileReview, profileReviewIdBatches } from "@/lib/profile-review-pagination";
import { readAllRows } from "@/lib/supabase-pagination";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  nonEmployeeProfileConfigs,
  type WorkforceProfileType,
  workforceProfileTypes
} from "@/lib/workforce-profiles";
import { reviewPeopleProfile, reviewProfileEdit } from "./actions";

type ReviewIssue = {
  account_id: string;
  block_submit: boolean;
  changed_fields?: string[];
  display_name: string | null;
  kind: string;
  manual_review: boolean;
  message: string | null;
  profile_type: WorkforceProfileType;
  updated_at: string | null;
};

type ReviewProfile = {
  id: string;
  profileType: WorkforceProfileType;
  dropxId: string;
  biometricId: string;
  fullName: string;
  locationId: string | null;
  location: string;
  designation: string;
  updatedAt: string | null;
  profileEditReviewPending: boolean;
  values: Record<string, string>;
  attachmentPaths: Array<{ field: string; label: string; path: string }>;
  issues: ReviewIssue[];
};

const issueLabels: Record<string, string> = {
  profile_edit: "Profile edit",
  pan: "PAN",
  pan_aadhaar: "Aadhaar / PAN link",
  dl: "Driving licence",
  pf_uan: "PF UAN",
  bank: "Bank account",
  vehicle: "Vehicle registration"
};

const profileEditFieldLabels: Record<string, string> = {
  mobile: "Mobile number",
  gender: "Gender",
  date_of_birth: "Date of birth",
  aadhaar_number: "Aadhaar number",
  pan_number: "PAN",
  eshram_uan: "eShram UAN",
  is_handicapped: "Handicapped status",
  address: "Address",
  state: "State",
  pincode: "Pincode",
  landmark: "Landmark",
  state_code: "State code",
  father_name: "Father name",
  blood_group: "Blood group",
  bank_account_no: "Bank account number",
  ifsc: "IFSC",
  pf_uan: "PF UAN",
  pf_account_no: "PF account number",
  esi_no: "ESI number",
  driving_license_no: "Driving licence number",
  driving_license_exp_date: "Driving licence expiry",
  vehicle_reg_no: "Vehicle registration",
  vehicle_reg_exp_date: "Registration expiry",
  vehicle_insurance_exp_date: "Vehicle insurance expiry",
  vehicle_pollution_exp_date: "Pollution expiry",
  emergency_contact_name: "Emergency contact name",
  emergency_contact_number: "Emergency contact number",
  emergency_contact_relation: "Emergency contact relation"
};

const issueValueKeys: Record<string, string[]> = {
  pan: ["pan_number"],
  pan_aadhaar: ["aadhaar_number"],
  dl: ["driving_license_no"],
  pf_uan: ["pf_uan"],
  bank: ["bank_account_no", "ifsc"],
  vehicle: ["vehicle_reg_no"]
};

const attachmentFields = [
  { key: "aadhaar_front_path", label: "Aadhaar front" },
  { key: "aadhaar_back_path", label: "Aadhaar back" },
  { key: "pan_upload_path", label: "PAN upload" },
  { key: "dl_front_path", label: "DL front" },
  { key: "dl_back_path", label: "DL back" },
  { key: "profile_photo_path", label: "Profile photo" }
] as const;

function text(value: unknown) {
  return String(value ?? "").trim();
}

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function formatDateTime(value: string | null) {
  return formatDashboardDateTime(value);
}

function verificationValue(profile: ReviewProfile, kind: string) {
  if (kind === "profile_edit") {
    const changedFields = profile.issues.find((issue) => issue.kind === kind)?.changed_fields ?? [];
    return changedFields.length
      ? changedFields.map((field) => profileEditFieldLabels[field] ?? field).join(", ")
      : "Profile details changed";
  }
  const values = (issueValueKeys[kind] ?? []).map((key) => profile.values[key]).filter(Boolean);
  return values.length ? values.join(" / ") : "Not provided";
}

function reviewKey(profileType: WorkforceProfileType, id: string) {
  return `${profileType}:${id}`;
}

async function readOptionalRows(query: unknown) {
  try {
    const result = await readAllRows(query);
    return result.error ? [] : (result.data ?? []) as Array<Record<string, unknown>>;
  } catch {
    return [] as Array<Record<string, unknown>>;
  }
}

async function loadReviewProfiles(
  companyId: string,
  locationScopeIds: string[],
  hasAllLocationAccess: boolean
) {
  if (!supabaseAdmin) {
    return { profiles: [] as ReviewProfile[], error: "Supabase service role key is not configured." };
  }
  const admin = supabaseAdmin;

  const attachmentColumns = attachmentFields.map((field) => field.key).join(", ");
  const employeeSelect = `id, employee_code, biometric_id, full_name, location_id, pan_number, aadhaar_number, driving_license_no, pf_uan, bank_account_no, ifsc, vehicle_reg_no, updated_at, ${attachmentColumns}, stations (station_code, station_name), designations (name)`;
  const workforceSelect = `id, dropx_id, biometric_id, full_name, location_id, pan_number, aadhaar_number, driving_license_no, pf_uan, bank_account_no, ifsc_code, vehicle_reg_no, updated_at, ${attachmentColumns}, stations (station_code, station_name), designations (name)`;
  const nonEmployeeSelect = `id, dropx_id, biometric_id, full_name, location_id, designation, pan_number, aadhaar_number, driving_license_no, pf_uan, bank_account_no, ifsc_code, vehicle_reg_no, updated_at, ${attachmentColumns}, stations (station_code, station_name)`;
  const nonEmployeeTypes = workforceProfileTypes.filter(
    (profileType): profileType is Exclude<WorkforceProfileType, "employee" | "workforce" | "field_executive"> =>
      profileType !== "employee" && profileType !== "workforce" && profileType !== "field_executive"
  );
  const queryProfileTypes: WorkforceProfileType[] = ["employee", "workforce", ...nonEmployeeTypes];
  const profileQueries = [
    readAllRows(admin
      .from("employees")
      .select(employeeSelect)
      .eq("company_id", companyId)
      .eq("profile_completion_status", "under_review")
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true })),
    readAllRows(admin
      .from("workforce")
      .select(workforceSelect)
      .eq("company_id", companyId)
      .eq("onboarding_status", "under_review")
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true })),
    ...nonEmployeeTypes.map((profileType) => readAllRows(admin
        .from(nonEmployeeProfileConfigs[profileType].table)
        .select(nonEmployeeSelect)
        .eq("company_id", companyId)
        .eq("onboarding_status", "under_review")
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true })))
  ];
  const profileResults = await Promise.all(profileQueries);

  const profileError = profileResults.find((result) => result.error)?.error;
  if (profileError) return { profiles: [] as ReviewProfile[], error: profileError.message };

  const profiles: ReviewProfile[] = [];
  profileResults.forEach((result, index) => {
    const profileType = queryProfileTypes[index];
    for (const raw of (result.data ?? []) as Array<Record<string, unknown>>) {
      const locationId = text(raw.location_id) || null;
      if (!hasAllLocationAccess && (!locationId || !locationScopeIds.includes(locationId))) continue;
      const station = firstRelation(raw.stations as { station_code?: string } | Array<{ station_code?: string }> | null);
      const designation = profileType === "employee" || profileType === "workforce"
        ? firstRelation(raw.designations as { name?: string } | Array<{ name?: string }> | null)?.name
        : raw.designation;
      const id = text(raw.id);
      profiles.push({
        id,
        profileType,
        dropxId: text(raw.employee_code ?? raw.dropx_id) || "-",
        biometricId: text(raw.biometric_id) || "-",
        fullName: text(raw.full_name) || "Unnamed profile",
        locationId,
        location: text(station?.station_code) || "-",
        designation: text(designation) || "-",
        updatedAt: text(raw.updated_at) || null,
        profileEditReviewPending: false,
        values: {
          pan_number: text(raw.pan_number),
          aadhaar_number: text(raw.aadhaar_number),
          driving_license_no: text(raw.driving_license_no),
          pf_uan: text(raw.pf_uan),
          bank_account_no: text(raw.bank_account_no),
          ifsc: text(raw.ifsc ?? raw.ifsc_code),
          vehicle_reg_no: text(raw.vehicle_reg_no)
        },
        attachmentPaths: attachmentFields
          .map((field) => ({ field: field.key, label: field.label, path: text(raw[field.key]) }))
          .filter((file) => Boolean(file.path)),
        issues: []
      });
    }
  });

  // Self-edit reviews are additive and intentionally fail open. A rollout
  // without the new flag column must never hide the established onboarding
  // review queue above.
  const profileEditEmployeeSelect = `id, employee_code, biometric_id, full_name, location_id, pan_number, aadhaar_number, driving_license_no, pf_uan, bank_account_no, ifsc, vehicle_reg_no, profile_edit_review_pending, updated_at, ${attachmentColumns}, stations (station_code, station_name), designations (name)`;
  const profileEditWorkforceSelect = `id, dropx_id, biometric_id, full_name, location_id, pan_number, aadhaar_number, driving_license_no, pf_uan, bank_account_no, ifsc_code, vehicle_reg_no, profile_edit_review_pending, updated_at, ${attachmentColumns}, stations (station_code, station_name), designations (name)`;
  const profileEditNonEmployeeSelect = `id, dropx_id, biometric_id, full_name, location_id, designation, pan_number, aadhaar_number, driving_license_no, pf_uan, bank_account_no, ifsc_code, vehicle_reg_no, profile_edit_review_pending, updated_at, ${attachmentColumns}, stations (station_code, station_name)`;
  const profileEditTypes: WorkforceProfileType[] = ["employee", "workforce", "contractor", "vendor"];
  const profileEditResults = await Promise.all([
    readOptionalRows(admin
      .from("employees")
      .select(profileEditEmployeeSelect)
      .eq("company_id", companyId)
      .eq("profile_completion_status", "active")
      .eq("profile_edit_review_pending", true)
      .eq("is_active", true)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true })),
    readOptionalRows(admin
      .from("workforce")
      .select(profileEditWorkforceSelect)
      .eq("company_id", companyId)
      .eq("onboarding_status", "active")
      .eq("profile_edit_review_pending", true)
      .eq("is_active", true)
      .eq("lifecycle_status", "active")
      .is("deleted_at", null)
      .is("deactivated_at", null)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true })),
    ...(["contractor", "vendor"] as const).map((profileType) => readOptionalRows(admin
      .from(nonEmployeeProfileConfigs[profileType].table)
      .select(profileEditNonEmployeeSelect)
      .eq("company_id", companyId)
      .eq("onboarding_status", "active")
      .eq("profile_edit_review_pending", true)
      .eq("is_active", true)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true })))
  ]);
  const knownProfileKeys = new Set(profiles.map((profile) => reviewKey(profile.profileType, profile.id)));
  profileEditResults.forEach((rows, index) => {
    const profileType = profileEditTypes[index];
    for (const raw of rows) {
      const id = text(raw.id);
      const key = reviewKey(profileType, id);
      if (!id || knownProfileKeys.has(key)) continue;
      const locationId = text(raw.location_id) || null;
      if (!hasAllLocationAccess && (!locationId || !locationScopeIds.includes(locationId))) continue;
      const station = firstRelation(raw.stations as { station_code?: string } | Array<{ station_code?: string }> | null);
      const designation = profileType === "employee" || profileType === "workforce"
        ? firstRelation(raw.designations as { name?: string } | Array<{ name?: string }> | null)?.name
        : raw.designation;
      profiles.push({
        id,
        profileType,
        dropxId: text(raw.employee_code ?? raw.dropx_id) || "-",
        biometricId: text(raw.biometric_id) || "-",
        fullName: text(raw.full_name) || "Unnamed profile",
        locationId,
        location: text(station?.station_code) || "-",
        designation: text(designation) || "-",
        updatedAt: text(raw.updated_at) || null,
        profileEditReviewPending: true,
        values: {
          pan_number: text(raw.pan_number),
          aadhaar_number: text(raw.aadhaar_number),
          driving_license_no: text(raw.driving_license_no),
          pf_uan: text(raw.pf_uan),
          bank_account_no: text(raw.bank_account_no),
          ifsc: text(raw.ifsc ?? raw.ifsc_code),
          vehicle_reg_no: text(raw.vehicle_reg_no)
        },
        attachmentPaths: attachmentFields
          .map((field) => ({ field: field.key, label: field.label, path: text(raw[field.key]) }))
          .filter((file) => Boolean(file.path)),
        issues: []
      });
      knownProfileKeys.add(key);
    }
  });

  const profileIdsByType = new Map<WorkforceProfileType, string[]>();
  for (const profile of profiles) {
    profileIdsByType.set(profile.profileType, [...(profileIdsByType.get(profile.profileType) ?? []), profile.id]);
  }

  const verificationRows: ReviewIssue[] = [];
  for (const [profileType, profileIds] of profileIdsByType) {
    for (const accountIds of profileReviewIdBatches(profileIds)) {
      const result = await readAllRows(admin
        .from("connect_profile_verifications")
        .select("account_id, profile_type, kind, manual_review, block_submit, display_name, message, updated_at")
        .eq("company_id", companyId)
        .eq("manual_review", true)
        .eq("profile_type", profileType)
        .in("account_id", accountIds)
        .order("account_id", { ascending: true })
        .order("kind", { ascending: true }));
      if (result.error) return { profiles: [] as ReviewProfile[], error: result.error.message };
      verificationRows.push(...(result.data ?? []) as ReviewIssue[]);
    }
  }

  const latestProfileEditFields = new Map<string, string[]>();
  const profileEditIdsByType = new Map<WorkforceProfileType, string[]>();
  for (const profile of profiles) {
    if (!profile.profileEditReviewPending) continue;
    profileEditIdsByType.set(
      profile.profileType,
      [...(profileEditIdsByType.get(profile.profileType) ?? []), profile.id]
    );
  }
  for (const [profileType, profileIds] of profileEditIdsByType) {
    for (const accountIds of profileReviewIdBatches(profileIds)) {
      const auditRows = await readOptionalRows(admin
        .from("connect_profile_edit_audit")
        .select("account_id, profile_type, changed_fields, created_at")
        .eq("company_id", companyId)
        .eq("event_code", "committed")
        .eq("profile_type", profileType)
        .in("account_id", accountIds)
        .order("created_at", { ascending: false }));
      for (const row of auditRows) {
        const key = reviewKey(profileType, text(row.account_id));
        if (latestProfileEditFields.has(key)) continue;
        latestProfileEditFields.set(
          key,
          Array.isArray(row.changed_fields) ? row.changed_fields.map(text).filter(Boolean) : []
        );
      }
    }
  }

  const issuesByProfile = new Map<string, ReviewIssue[]>();
  for (const row of verificationRows) {
    if (!workforceProfileTypes.includes(row.profile_type)) continue;
    const key = reviewKey(row.profile_type, row.account_id);
    issuesByProfile.set(key, [...(issuesByProfile.get(key) ?? []), row]);
  }
  for (const profile of profiles) {
    profile.issues = issuesByProfile.get(reviewKey(profile.profileType, profile.id)) ?? [];
    if (profile.profileEditReviewPending) {
      profile.issues.unshift({
        account_id: profile.id,
        block_submit: false,
        changed_fields: latestProfileEditFields.get(reviewKey(profile.profileType, profile.id)) ?? [],
        display_name: null,
        kind: "profile_edit",
        manual_review: true,
        message: "These OTP-verified profile changes require administrator approval.",
        profile_type: profile.profileType,
        updated_at: profile.updatedAt
      });
    }
  }

  profiles.sort((a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt)));
  return { profiles, error: null as string | null };
}

export const dynamic = "force-dynamic";

export default async function PeopleReviewPage({
  searchParams
}: {
  searchParams?: {
    designation?: string;
    error?: string;
    issue?: string;
    notice?: string;
    page?: string;
    review?: string;
    search?: string;
  };
}) {
  const authorization = await requirePagePermission("people_review", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.people_review;
  const { profiles, error } = await loadReviewProfiles(
    companyId,
    authorization.locationScopeIds,
    authorization.hasAllLocationAccess
  );
  const designation = text(searchParams?.designation);
  const issue = text(searchParams?.issue);
  const searchValue = text(searchParams?.search);
  const search = searchValue.toLowerCase();
  const designationOptions = Array.from(
    new Set(profiles.map((profile) => profile.designation).filter((value) => value && value !== "-"))
  ).sort((a, b) => a.localeCompare(b));
  const filteredProfiles = profiles.filter((profile) => {
    if (designation && profile.designation !== designation) return false;
    if (issue && !profile.issues.some((item) => item.kind === issue)) return false;
    if (search && ![
      profile.fullName,
      profile.dropxId,
      profile.biometricId,
      profile.location,
      profile.designation
    ].some((value) => value.toLowerCase().includes(search))) return false;
    return true;
  });
  const paginatedProfiles = paginateProfileReview(filteredProfiles, searchParams?.page);
  const listHref = (page: number, review?: string) => {
    const params = new URLSearchParams();
    if (designation) params.set("designation", designation);
    if (issue) params.set("issue", issue);
    if (searchValue) params.set("search", searchValue);
    if (page > 1) params.set("page", String(page));
    if (review) params.set("review", review);
    const query = params.toString();
    return query ? `/people/review?${query}` : "/people/review";
  };
  const selected = profiles.find((profile) => reviewKey(profile.profileType, profile.id) === searchParams?.review) ?? null;
  const selectedAttachments = selected?.attachmentPaths ?? [];
  const selectedReviewAction = selected?.profileEditReviewPending ? reviewProfileEdit : reviewPeopleProfile;

  return (
    <AppShell active="Under Review" pageCode="people_review">
      <PageHead
        eyebrow="People"
        title="Profile Review"
        subtitle="Review only the fields that need human attention, then approve or return the profile."
      />

      {searchParams?.notice ? <div className="notice">{searchParams.notice}</div> : null}
      {searchParams?.error || error ? (
        <div className="error-box">
          <strong>Action required</strong>
          <p>{searchParams?.error || error}</p>
        </div>
      ) : null}

      <section className="card people-review-listing">
        <div className="panel-head people-review-listing-head">
          <div>
            <h2>Profiles awaiting decision</h2>
            <p className="subtle">
              {filteredProfiles.length} of {profiles.length} profiles
              {paginatedProfiles.pageCount > 1
                ? ` · showing ${paginatedProfiles.firstItem}-${paginatedProfiles.lastItem}`
                : ""}
            </p>
          </div>
          <form className="people-review-filters" method="get">
            <label>
              <span>Designation</span>
              <select className="select" defaultValue={designation} name="designation">
                <option value="">All designations</option>
                {designationOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Review field</span>
              <select className="select" defaultValue={issue} name="issue">
                <option value="">All review fields</option>
                {Object.entries(issueLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="people-review-search">
              <span>Search</span>
              <span className="people-review-search-field">
                <Search aria-hidden="true" size={15} />
                <input className="field" defaultValue={searchValue} name="search" placeholder="Name, ID, biometric ID" />
              </span>
            </label>
            <button className="button secondary" type="submit">Filter</button>
            {(designation || issue || search) ? <PendingLink className="button secondary" href="/people/review">Clear</PendingLink> : null}
          </form>
        </div>

        <div className="table-wrap">
          <table className="people-review-table">
            <thead>
              <tr>
                <th>Profile</th>
                <th>Designation</th>
                <th>Location</th>
                <th>Fields requiring review</th>
                <th>Updated</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {paginatedProfiles.items.length ? paginatedProfiles.items.map((profile) => (
                <tr key={reviewKey(profile.profileType, profile.id)}>
                  <td>
                    <div className="people-review-person">
                      <span className="people-review-avatar"><UserRound aria-hidden="true" size={18} /></span>
                      <span>
                        <strong>{profile.fullName}</strong>
                        <small>{profile.dropxId} / Bio {profile.biometricId}</small>
                      </span>
                    </div>
                  </td>
                  <td>
                    <strong>{profile.designation}</strong>
                  </td>
                  <td>{profile.location}</td>
                  <td>
                    <div className="people-review-chips">
                      {profile.issues.length ? profile.issues.map((item) => (
                        <span className="people-review-chip" key={item.kind}>{issueLabels[item.kind] ?? item.kind}</span>
                      )) : <span className="people-review-chip muted">Reason unavailable</span>}
                    </div>
                  </td>
                  <td>{formatDateTime(profile.updatedAt)}</td>
                  <td>
                    <PendingLink
                      className="button secondary compact"
                      href={listHref(paginatedProfiles.page, reviewKey(profile.profileType, profile.id))}
                    >
                      Review
                    </PendingLink>
                  </td>
                </tr>
              )) : (
                <tr>
                  <td className="empty-cell" colSpan={6}>
                    <BadgeCheck aria-hidden="true" size={24} />
                    <strong>No profiles need review</strong>
                    <span>Profiles matching these filters will appear here.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {paginatedProfiles.pageCount > 1 ? (
          <nav aria-label="Profile review pages" className="people-review-pagination">
            <span>
              Page {paginatedProfiles.page} of {paginatedProfiles.pageCount}
            </span>
            <div>
              {paginatedProfiles.page > 1 ? (
                <PendingLink className="button secondary compact" href={listHref(paginatedProfiles.page - 1)}>
                  Previous
                </PendingLink>
              ) : (
                <button className="button secondary compact" disabled type="button">Previous</button>
              )}
              {paginatedProfiles.page < paginatedProfiles.pageCount ? (
                <PendingLink className="button secondary compact" href={listHref(paginatedProfiles.page + 1)}>
                  Next
                </PendingLink>
              ) : (
                <button className="button secondary compact" disabled type="button">Next</button>
              )}
            </div>
          </nav>
        ) : null}
      </section>

      {selected ? (
        <div className="modal-backdrop">
          <section aria-modal="true" className="modal-panel wide people-review-modal" role="dialog">
            <div className="panel-head people-review-modal-head">
              <div>
                <span className="profile-review-eyebrow">{selected.designation}</span>
                <h2>{selected.fullName}</h2>
                <p className="subtle">{selected.dropxId} / Biometric ID {selected.biometricId} / {selected.location}</p>
              </div>
              <PendingLink aria-label="Close review" className="icon-button" href={listHref(paginatedProfiles.page)} title="Close">
                <ArrowLeft aria-hidden="true" size={18} />
              </PendingLink>
            </div>

            <div className="people-review-modal-body">
              <section>
                <div className="people-review-section-head">
                  <div>
                    <h3>Fields requiring review</h3>
                    <p>Only exceptions that need a human decision are shown.</p>
                  </div>
                  <StatusPill status="Under review" />
                </div>
                <div className="people-review-issues">
                  {selected.issues.length ? selected.issues.map((item) => (
                    <article className="people-review-issue" key={item.kind}>
                      <span className="people-review-issue-icon">
                        {item.kind === "pf_uan" ? <Fingerprint aria-hidden="true" size={19} /> : <ShieldAlert aria-hidden="true" size={19} />}
                      </span>
                      <div>
                        <span className="people-review-field-label">{issueLabels[item.kind] ?? item.kind}</span>
                        <strong>{verificationValue(selected, item.kind)}</strong>
                        {item.display_name ? <p>Provider name: <b>{item.display_name}</b></p> : null}
                        <p className="people-review-reason">
                          <AlertTriangle aria-hidden="true" size={14} />
                          {item.message || "This verification requires manual review."}
                        </p>
                      </div>
                    </article>
                  )) : (
                    <div className="people-review-missing-reason">
                      <AlertTriangle aria-hidden="true" size={19} />
                      <div>
                        <strong>Review reason unavailable</strong>
                        <p>This is a legacy under-review profile without a saved verification exception.</p>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              <section className="people-review-attachments">
                <div className="people-review-section-head">
                  <div>
                    <h3>Attached files</h3>
                    <p>Open the documents submitted with this profile.</p>
                  </div>
                  <span className="people-review-file-count">{selectedAttachments.length} files</span>
                </div>
                {selectedAttachments.length ? (
                  <div className="people-review-file-grid">
                    {selectedAttachments.map((file) => (
                      <article className="people-review-file" key={`${file.label}:${file.path}`}>
                        <span className="people-review-file-icon">
                          <FileText aria-hidden="true" size={18} />
                        </span>
                        <div>
                          <strong>{file.label}</strong>
                          <span>Uploaded</span>
                        </div>
                        <a
                          className="button secondary compact"
                          href={`/api/people/profile-file?profile_type=${encodeURIComponent(selected.profileType)}&id=${encodeURIComponent(selected.id)}&field=${encodeURIComponent(file.field)}`}
                          rel="noreferrer"
                          target="_blank"
                        >
                          <Eye aria-hidden="true" size={15} />
                          View
                        </a>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="people-review-no-files">No files are attached to this profile.</p>
                )}
              </section>

              {permission.canEdit ? (
                <section className="profile-review-panel people-review-decision">
                  <div className="profile-review-head">
                    <span className="profile-review-eyebrow">Decision</span>
                    <h3>Complete profile review</h3>
                    <p>Approve the profile or return only the fields above for correction.</p>
                  </div>
                  <div className="profile-review-options">
                    <div className="profile-review-option profile-review-option-approve">
                      <div>
                        <h4>{selected.profileEditReviewPending ? "Approve profile changes" : "Approve profile"}</h4>
                        <p>{selected.profileEditReviewPending
                          ? "Accept these changes and close the review while keeping the profile active."
                          : "Activate this profile after confirming the review exceptions are acceptable."}</p>
                      </div>
                      <form action={selectedReviewAction} className="profile-review-approve">
                        <input name="id" type="hidden" value={selected.id} />
                        <input name="profile_type" type="hidden" value={selected.profileType} />
                        {selected.profileEditReviewPending
                          ? <input name="review_version" type="hidden" value={selected.updatedAt ?? ""} />
                          : null}
                        <input name="review_action" type="hidden" value="approve" />
                        <SubmitButton
                          className="button profile-review-approve-button"
                          confirmDescription={selected.profileEditReviewPending
                            ? "The profile will remain active and these changes will be accepted."
                            : "This profile will become active."}
                          confirmMessage={selected.profileEditReviewPending ? "Approve these profile changes?" : "Approve this profile?"}
                          confirmSubmitText={selected.profileEditReviewPending ? "Approve changes" : "Approve profile"}
                          confirmTitle={selected.profileEditReviewPending ? "Approve profile changes" : "Approve profile"}
                          pendingText="Approving"
                        >
                          {selected.profileEditReviewPending ? "Approve changes" : "Approve profile"}
                        </SubmitButton>
                      </form>
                    </div>
                    <div className="profile-review-option profile-review-option-return">
                      <div>
                        <h4>{selected.profileEditReviewPending ? "Return profile changes" : "Return for correction"}</h4>
                        <p>{selected.profileEditReviewPending
                          ? "The profile stays active while the person corrects and resubmits through OTP-protected editing."
                          : "The person can edit and resubmit the returned profile in DropX One."}</p>
                      </div>
                      <form action={selectedReviewAction} className="profile-review-return">
                        <input name="id" type="hidden" value={selected.id} />
                        <input name="profile_type" type="hidden" value={selected.profileType} />
                        {selected.profileEditReviewPending
                          ? <input name="review_version" type="hidden" value={selected.updatedAt ?? ""} />
                          : null}
                        <input name="review_action" type="hidden" value="return" />
                        <label>
                          Return remarks <strong>*</strong>
                          <textarea className="field" name="return_remarks" placeholder="Explain what must be corrected" required />
                        </label>
                        <div className="profile-review-return-actions">
                          <SubmitButton
                            className="button profile-review-return-button"
                            confirmDescription={selected.profileEditReviewPending
                              ? "The profile will remain active and these changes will stay pending."
                              : "The profile will reopen in DropX One with these remarks."}
                            confirmMessage={selected.profileEditReviewPending ? "Return these profile changes?" : "Return this profile for correction?"}
                            confirmSubmitText={selected.profileEditReviewPending ? "Return changes" : "Return profile"}
                            confirmTitle={selected.profileEditReviewPending ? "Return profile changes" : "Return profile"}
                            pendingText="Returning"
                          >
                            {selected.profileEditReviewPending ? "Return changes" : "Return profile"}
                          </SubmitButton>
                        </div>
                      </form>
                    </div>
                  </div>
                </section>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}
