"use client";

import {
  AppPageAccessSelect,
  appPageOptions,
  defaultAppPageAccess
} from "@/components/app-page-access-select";
import { FieldRuleMatrix } from "@/components/designation-form";
import {
  normalizeCategoryProfileFieldRules,
  workforceProfileFields
} from "@/lib/profile-field-rules";
import { SubmitButton } from "@/components/submit-button";

export type WorkforceCategoryInitial = {
  id: string;
  code: string;
  name: string;
  profile_field_rules?: unknown;
  app_page_access?: string[] | null;
  statutory_enabled?: boolean;
  direct_activate?: boolean;
  is_system: boolean;
  is_active: boolean;
};

export function WorkforceCategoryForm({
  action,
  initial,
  submitLabel
}: {
  action: (formData: FormData) => void;
  initial?: WorkforceCategoryInitial | null;
  submitLabel: string;
}) {
  const rules = normalizeCategoryProfileFieldRules(initial?.profile_field_rules);
  const selectedPages = (initial?.app_page_access ?? defaultAppPageAccess)
    .filter((page) => appPageOptions.some((option) => option.value === page));

  return (
    <form action={action} className="designation-form">
      {initial ? <input name="id" type="hidden" value={initial.id} /> : null}
      <div className="form-grid three">
        <label>
          Category code
          <input
            className="field"
            defaultValue={initial?.code ?? ""}
            name="code"
            pattern="[a-z0-9_]+"
            placeholder="e.g. consultants"
            readOnly={Boolean(initial?.is_system)}
            required
          />
        </label>
        <label>
          Category name
          <input className="field" defaultValue={initial?.name ?? ""} name="name" placeholder="Enter category name" required />
        </label>
        {initial ? (
          <label>
            Status
            <select className="field" defaultValue={initial.is_active ? "active" : "inactive"} name="status">
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
        ) : null}
      </div>

      <section className="workforce-category-page-access">
        <div>
          <strong>Statutory applicability</strong>
          <p className="subtle">Show the Not Applicable, PF and ESI selection while onboarding this category.</p>
        </div>
        <label className="checkbox-line">
          <input
            defaultChecked={initial?.statutory_enabled ?? false}
            name="statutory_enabled"
            type="checkbox"
            value="true"
          />
          Enable statutory applicability
        </label>
      </section>

      <section className="workforce-category-page-access">
        <div>
          <strong>DropX One page access</strong>
          <p className="subtle">A page is visible only when enabled here and for the profile&apos;s designation.</p>
        </div>
        <AppPageAccessSelect initialPages={selectedPages} />
      </section>

      <section className="workforce-category-page-access">
        <div>
          <strong>Direct activation</strong>
          <p className="subtle">Let dashboard users complete this category's enabled onboarding fields and activate the profile immediately.</p>
        </div>
        <label className="checkbox-line">
          <input
            defaultChecked={initial?.direct_activate ?? false}
            name="direct_activate"
            type="checkbox"
            value="true"
          />
          Enable direct activation from Dashboard
        </label>
      </section>

      <div className="workforce-category-rule-matrix">
        <FieldRuleMatrix
          fields={workforceProfileFields}
          rules={rules}
          title="Onboarding fields"
        />
      </div>

      <div className="form-actions right">
        <SubmitButton className="button" pendingText="Saving">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
