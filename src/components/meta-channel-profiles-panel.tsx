"use client";
import { ReportTable } from "@/components/report-table";


import { useState } from "react";
import { deleteMetaChannelProfile, saveMetaChannelProfile } from "@/app/settings/meta-messaging-actions";
import { SubmitButton } from "@/components/submit-button";

export type MetaChannelProfile = {
  id: string;
  channel: "facebook" | "instagram";
  profile_name: string;
  page_id: string | null;
  page_name: string | null;
  instagram_business_account_id: string | null;
  connected_page_id: string | null;
  graph_api_version: string;
  chat_enabled: boolean;
  is_active: boolean;
  is_default: boolean;
  token_configured: boolean;
  token_mask: string;
  usage_count: number;
};

type Props = {
  canEdit: boolean;
  enabled: boolean;
  platform: "facebook" | "instagram";
  profiles: MetaChannelProfile[];
};

function platformLabel(platform: "facebook" | "instagram") {
  return platform === "instagram" ? "Instagram" : "Pages / Messenger";
}

export function MetaChannelProfilesPanel({ canEdit, enabled, platform, profiles }: Props) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<MetaChannelProfile | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const label = platformLabel(platform);

  function openProfile(profile: MetaChannelProfile | null) {
    setEditingProfile(profile);
    setTokenInput("");
    setModalOpen(true);
  }

  return (
    <div className="whatsapp-settings-stack">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{label} profiles</h2>
            <p className="subtle">
              {platform === "facebook"
                ? "Create one profile for each Facebook Page inbox."
                : "Create one profile for each Instagram business inbox."}
            </p>
          </div>
          <div className="panel-head-actions">
            {enabled ? <span className="status-pill good">Enabled</span> : null}
            <button className="button compact" disabled={!canEdit} onClick={() => openProfile(null)} type="button">
              Add profile
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <ReportTable>
            <thead>
              <tr>
                <th>Profile</th>
                {platform === "facebook" ? <th>Page ID</th> : <th>Instagram Business ID</th>}
                <th>Page name</th>
                <th>Graph API</th>
                <th>Token</th>
                <th>Chat</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {profiles.length ? profiles.map((profile) => (
                <tr key={profile.id}>
                  <td><strong>{profile.profile_name}</strong>{profile.is_default ? <><br /><span className="subtle">Default profile</span></> : null}</td>
                  <td>{platform === "facebook" ? profile.page_id || "-" : profile.instagram_business_account_id || "-"}</td>
                  <td>{profile.page_name || profile.connected_page_id || "-"}</td>
                  <td>{profile.graph_api_version}</td>
                  <td>{profile.token_configured ? "Configured" : "Missing"}</td>
                  <td>{profile.chat_enabled ? <span className="status-pill good">Enabled</span> : null}</td>
                  <td><span className={`status-pill ${profile.is_active ? "good" : "warn"}`}>{profile.is_active ? "Active" : "Inactive"}</span></td>
                  <td>
                    <div className="whatsapp-profile-actions">
                      <button className="button secondary compact" disabled={!canEdit} onClick={() => openProfile(profile)} type="button">
                        Edit
                      </button>
                      <form action={deleteMetaChannelProfile}>
                        <input name="platform" type="hidden" value={platform} />
                        <input name="profile_id" type="hidden" value={profile.id} />
                        <SubmitButton className="button danger compact" disabled={!canEdit || profile.usage_count > 0}>
                          Delete
                        </SubmitButton>
                      </form>
                      {profile.usage_count > 0 ? <span className="subtle tiny-note">{profile.usage_count} used</span> : null}
                    </div>
                  </td>
                </tr>
              )) : <tr><td className="empty-cell" colSpan={8}>No {label} profiles added yet.</td></tr>}
            </tbody>
          </ReportTable>
        </div>
      </section>

      {modalOpen ? (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setModalOpen(false);
          }}
        >
          <section className="modal-panel wide" aria-label={`Configure ${label} profile`}>
            <div className="panel-head">
              <div>
                <h2>{editingProfile ? `Edit ${label} profile` : `Add ${label} profile`}</h2>
                <p className="subtle">Account credentials for one Meta messaging inbox.</p>
              </div>
              <button className="icon-button" onClick={() => setModalOpen(false)} type="button">x</button>
            </div>
            <form action={saveMetaChannelProfile} className="whatsapp-general-form">
              <input name="platform" type="hidden" value={platform} />
              <input name="profile_id" type="hidden" value={editingProfile?.id ?? ""} />
              <div className="form-grid three">
                <label>Profile name
                  <input className="field" defaultValue={editingProfile?.profile_name ?? ""} name="profile_name" required />
                </label>
                {platform === "facebook" ? (
                  <label>Page ID
                    <input className="field" defaultValue={editingProfile?.page_id ?? ""} name="page_id" required />
                  </label>
                ) : (
                  <label>Instagram business account ID
                    <input className="field" defaultValue={editingProfile?.instagram_business_account_id ?? ""} name="instagram_business_account_id" required />
                  </label>
                )}
                <label>{platform === "facebook" ? "Page name" : "Display name"}
                  <input className="field" defaultValue={editingProfile?.page_name ?? ""} name="page_name" />
                </label>
                <label>Connected Page ID
                  <input className="field" defaultValue={editingProfile?.connected_page_id ?? editingProfile?.page_id ?? ""} name="connected_page_id" />
                </label>
                <label>Graph API version
                  <input className="field mono" defaultValue={editingProfile?.graph_api_version ?? "v25.0"} name="graph_api_version" required />
                </label>
                <label className="span-2">Access token
                  <input
                    className="field"
                    name="access_token"
                    onChange={(event) => setTokenInput(event.target.value)}
                    placeholder={editingProfile?.token_configured ? "Token configured - paste only to replace" : "Paste generated access token"}
                    type="password"
                    value={tokenInput}
                  />
                  {editingProfile?.token_configured ? <small className="field-hint">A token is already saved. Leave blank to keep it, or paste a new generated token to replace it.</small> : null}
                </label>
              </div>
              <div className="inline-toggle-row">
                <label className="toggle-field compact-toggle"><input defaultChecked={editingProfile?.chat_enabled ?? true} name="chat_enabled" type="checkbox" /><span>Enable chat</span></label>
                <label className="toggle-field compact-toggle"><input defaultChecked={editingProfile?.is_active ?? true} name="is_active" type="checkbox" /><span>Active</span></label>
                <label className="toggle-field compact-toggle"><input defaultChecked={editingProfile?.is_default ?? profiles.length === 0} name="is_default" type="checkbox" /><span>Default profile</span></label>
              </div>
              <div className="form-actions modal-actions">
                <button className="button secondary" onClick={() => setModalOpen(false)} type="button">Cancel</button>
                <SubmitButton>{editingProfile ? "Save profile" : "Create profile"}</SubmitButton>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
