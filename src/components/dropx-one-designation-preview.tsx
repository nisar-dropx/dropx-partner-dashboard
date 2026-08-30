"use client";

import type { ProfileFieldChannelRules, ProfileFieldRule } from "@/lib/profile-field-rules";

const pageLabels: Record<string, string> = {
  dashboard: "Home",
  attendance: "Attendance",
  roster: "Roster",
  leave: "Leave",
  performance: "Performance"
};

export function DropxOneDesignationPreview({
  designationName,
  fields,
  pageAccess,
  rules,
  scopeLabel
}: {
  designationName: string;
  fields: ProfileFieldRule[];
  pageAccess: string[];
  rules: ProfileFieldChannelRules;
  scopeLabel: string;
}) {
  const visibleFields = fields.filter((field) => rules.dropx_one.enabled.includes(field.key));
  const required = new Set(rules.dropx_one.required);
  const pages = Array.from(new Set(["profile", ...pageAccess, "settings"]));

  return (
    <aside className="dropx-one-preview-wrap" aria-label={`DropX One preview for ${designationName || "new designation"}`}>
      <div className="dropx-one-preview-copy">
        <span className="eyebrow">Live mobile preview</span>
        <h4>DropX One · {scopeLabel}</h4>
        <p>Shows the effective menus and registration fields after engagement-type restrictions are applied.</p>
      </div>
      <div className="dropx-one-phone">
        <div className="dropx-one-phone-speaker" />
        <div className="dropx-one-phone-screen">
          <header><span>DropX One</span><small>{designationName || "New designation"}</small></header>
          <nav>
            {pages.map((page) => <span key={page}>{page === "profile" ? "My Profile" : page === "settings" ? "Settings" : pageLabels[page] ?? page}</span>)}
          </nav>
          <section>
            <strong>Registration details</strong>
            <small>{visibleFields.length} visible · {visibleFields.filter((field) => required.has(field.key)).length} required</small>
            <div className="dropx-one-preview-fields">
              {visibleFields.length ? visibleFields.map((field) => (
                <label key={field.key}>
                  <span>{field.label}{required.has(field.key) ? <b> *</b> : null}</span>
                  <i>{field.kind === "file" ? "Upload" : field.kind === "select" ? "Select" : "Enter value"}</i>
                </label>
              )) : <p>No registration fields enabled.</p>}
            </div>
          </section>
        </div>
      </div>
    </aside>
  );
}
