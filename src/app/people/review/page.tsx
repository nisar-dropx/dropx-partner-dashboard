import { AlertTriangle, ArrowLeft, BadgeCheck, Eye, FileText, Fingerprint, Search, ShieldAlert, UserRound } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { WorkforceProfileType } from "@/lib/workforce-profiles";
import { reviewPeopleProfile } from "./actions";

type ReviewIssue = {
  account_id: string;
  block_submit: boolean;
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
  values: Record<string, string>;
  attachmentPaths: Array<{ field: string; label: string; path: string }>;
  issues: ReviewIssue[];
};

const issueLabels: Record<string, string> = {
  pan: "PAN",
  pan_aadhaar: "Aadhaar / PAN link",
  dl: "Driving licence",
  pf_uan: "PF UAN",
  bank: "Bank account",
  vehicle: "Vehicle registration"
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
  const values = (issueValueKeys[kind] ?? []).map((key) => profile.values[key]).filter(Boolean);
  return values.length ? values.join(" / ") : "Not provided";
}

function reviewKey(profileType: WorkforceProfileType, id: string) {
  return `${profileType}:${id}`;
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
  const queryProfileTypes: WorkforceProfileType[] = ["employee"];
  const profileQueries = [
    admin
      .from("employees")
      .select(employeeSelect)
      .eq("company_id", companyId)
      .eq("profile_completion_status", "under_review")
  ];
  const [verificationResult, ...profileResults] = await Promise.all([
    admin
      .from("connect_profile_verifications")
      .select("account_id, profile_type, kind, manual_review, block_submit, display_name, message, updated_at")
      .eq("company_id", companyId)
      .eq("manual_review", true),
    ...profileQueries
  ]);

  const firstError = [verificationResult, ...profileResults].find((result) => result.error)?.error;
  if (firstError) return { profiles: [] as ReviewProfile[], error: firstError.message };

  const issuesByProfile = new Map<string, ReviewIssue[]>();
  for (const row of (verificationResult.data ?? []) as ReviewIssue[]) {
    if (row.profile_type !== "employee") continue;
    const key = reviewKey(row.profile_type, row.account_id);
    issuesByProfile.set(key, [...(issuesByProfile.get(key) ?? []), row]);
  }

  const profiles: ReviewProfile[] = [];
  profileResults.forEach((result, index) => {
    const profileType = queryProfileTypes[index];
    for (const raw of (result.data ?? []) as unknown as Array<Record<string, unknown>>) {
      const locationId = text(raw.location_id) || null;
      if (!hasAllLocationAccess && (!locationId || !locationScopeIds.includes(locationId))) continue;
      const station = firstRelation(raw.stations as { station_code?: string } | Array<{ station_code?: string }> | null);
      const designation = profileType === "employee"
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
        issues: issuesByProfile.get(reviewKey(profileType, id)) ?? []
      });
    }
  });

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
  const search = text(searchParams?.search).toLowerCase();
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
  const selected = profiles.find((profile) => reviewKey(profile.profileType, profile.id) === searchParams?.review) ?? null;
  const selectedAttachments = selected?.attachmentPaths ?? [];

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
            <p className="subtle">{filteredProfiles.length} of {profiles.length} profiles</p>
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
                <input className="field" defaultValue={searchParams?.search ?? ""} name="search" placeholder="Name, ID, biometric ID" />
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
              {filteredProfiles.length ? filteredProfiles.map((profile) => (
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
                      href={`/people/review?review=${encodeURIComponent(reviewKey(profile.profileType, profile.id))}`}
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
              <PendingLink aria-label="Close review" className="icon-button" href="/people/review" title="Close">
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
                        <h4>Approve profile</h4>
                        <p>Activate this profile after confirming the review exceptions are acceptable.</p>
                      </div>
                      <form action={reviewPeopleProfile} className="profile-review-approve">
                        <input name="id" type="hidden" value={selected.id} />
                        <input name="profile_type" type="hidden" value={selected.profileType} />
                        <input name="review_action" type="hidden" value="approve" />
                        <SubmitButton
                          className="button profile-review-approve-button"
                          confirmDescription="This profile will become active."
                          confirmMessage="Approve this profile?"
                          confirmSubmitText="Approve profile"
                          confirmTitle="Approve profile"
                          pendingText="Approving"
                        >
                          Approve profile
                        </SubmitButton>
                      </form>
                    </div>
                    <div className="profile-review-option profile-review-option-return">
                      <div>
                        <h4>Return for correction</h4>
                        <p>The person can edit and resubmit the returned profile in DropX One.</p>
                      </div>
                      <form action={reviewPeopleProfile} className="profile-review-return">
                        <input name="id" type="hidden" value={selected.id} />
                        <input name="profile_type" type="hidden" value={selected.profileType} />
                        <input name="review_action" type="hidden" value="return" />
                        <label>
                          Return remarks <strong>*</strong>
                          <textarea className="field" name="return_remarks" placeholder="Explain what must be corrected" required />
                        </label>
                        <div className="profile-review-return-actions">
                          <SubmitButton
                            className="button profile-review-return-button"
                            confirmDescription="The profile will reopen in DropX One with these remarks."
                            confirmMessage="Return this profile for correction?"
                            confirmSubmitText="Return profile"
                            confirmTitle="Return profile"
                            pendingText="Returning"
                          >
                            Return profile
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
