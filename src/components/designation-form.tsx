"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  AppPageAccessSelect,
  appPageOptions,
  defaultAppPageAccess
} from "@/components/app-page-access-select";
import { DropxOneDesignationPreview } from "@/components/dropx-one-designation-preview";
import { SubmitButton } from "@/components/submit-button";
import type { DesignationBusinessCategory } from "@/lib/designation-business-categories";
import { normalizeDesignationCategories, type DesignationCategory } from "@/lib/designation-categories";
import {
  designationProfileDestinationsForModule,
  inferDesignationProfileDestination,
  type DesignationProfileDestination
} from "@/lib/designation-profile-destination";
import {
  designationPortalOptions,
  normalizeDesignationPortalPermissions
} from "@/lib/designation-portal-access";
import {
  intersectProfileFieldChannelRules,
  normalizeCategoryProfileFieldRules,
  profileFieldRulesForCategory,
  type ProfileFieldChannelRules,
  type ProfileFieldRule,
  type ProfileFieldRuleSet,
  workforceProfileFields
} from "@/lib/profile-field-rules";

type ProviderOption = {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
};

type ModelOption = {
  id: string;
  code: string;
  name: string;
  provider?: string | null;
};

type DesignationInitial = {
  id: string;
  code: string;
  name: string;
  designation_category_id?: string | null;
  profile_destination?: DesignationProfileDestination | null;
  registration_category_code?: string | null;
  provider_ids: string[];
  model_ids?: string[] | null;
  onboarding_categories?: string[] | null;
  app_page_access?: string[] | null;
  onboarding_role_ids?: string[] | null;
  portal_permissions?: unknown;
  profile_field_rules?: unknown;
  is_field_operations?: boolean | null;
  is_active: boolean;
};

export type OnboardingRoleOption = {
  id: string;
  code: string;
  name: string;
};

function PortalAccessMatrix({ initialValue }: { initialValue?: unknown }) {
  const [permissions, setPermissions] = useState(() => normalizeDesignationPortalPermissions(initialValue));

  function updatePermission(portal: typeof designationPortalOptions[number]["code"], action: "add" | "view" | "edit", checked: boolean) {
    setPermissions((current) => {
      const portalPermissions = { ...current[portal], [action]: checked };
      if (action === "edit" && checked) portalPermissions.view = true;
      if (action === "view" && !checked) portalPermissions.edit = false;
      return { ...current, [portal]: portalPermissions };
    });
  }

  return (
    <div className="designation-portal-matrix">
      <div className="designation-portal-head" aria-hidden="true">
        <span>Portal</span><span>Add</span><span>View</span><span>Edit</span>
      </div>
      {designationPortalOptions.map((portal) => (
        <div className="designation-portal-row" key={portal.code}>
          <strong>{portal.label}</strong>
          {(["add", "view", "edit"] as const).map((action) => (
            <label key={action} title={`${action} People in ${portal.label}`}>
              <input
                checked={permissions[portal.code][action]}
                name={`portal_${portal.code}_${action}`}
                onChange={(event) => updatePermission(portal.code, action, event.target.checked)}
                type="checkbox"
              />
              <span className="sr-only">{action}</span>
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

function OnboardingRoleMultiSelect({ options, selectedValues }: { options: OnboardingRoleOption[]; selectedValues: string[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(selectedValues);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return options.filter((option) => !term || `${option.name} ${option.code}`.toLowerCase().includes(term));
  }, [options, query]);

  useEffect(() => {
    function close(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  function toggle(id: string) {
    setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  function toggleAllFiltered() {
    const ids = filtered.map((option) => option.id);
    const allSelected = ids.length > 0 && ids.every((id) => selectedSet.has(id));
    setSelected((current) => allSelected ? current.filter((id) => !ids.includes(id)) : Array.from(new Set([...current, ...ids])));
  }

  const labels = options.filter((option) => selectedSet.has(option.id));
  return (
    <div className="multi-select" ref={rootRef}>
      {selected.map((id) => <input key={id} name="onboarding_role_ids" type="hidden" value={id} />)}
      <button className={`multi-select-trigger ${open ? "open" : ""}`} onClick={() => setOpen((value) => !value)} type="button">
        <span className="multi-select-summary">{labels.length ? labels.map((role) => role.name).join(", ") : "Owner only"}</span>
        <ChevronDown aria-hidden="true" className="multi-select-chevron" size={16} strokeWidth={2.4} />
      </button>
      {open ? (
        <div className="multi-select-menu">
          <div className="multi-select-search">
            <input className="field multi-select-search-field" onChange={(event) => setQuery(event.target.value)} placeholder="Search user role" value={query} />
          </div>
          <label className="multi-select-all">
            <input checked={filtered.length > 0 && filtered.every((role) => selectedSet.has(role.id))} onChange={toggleAllFiltered} type="checkbox" />
            <span>Select all filtered</span>
            <small>{filtered.length} roles</small>
          </label>
          <div className="multi-select-options">
            {filtered.map((role) => (
              <label className="multi-select-option" key={role.id}>
                <input checked={selectedSet.has(role.id)} onChange={() => toggle(role.id)} type="checkbox" />
                <span><strong>{role.name}</strong><small>{role.code}</small></span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export type WorkforceCategoryOption = {
  code: string;
  name: string;
  profile_field_rules?: unknown;
  app_page_access?: string[] | null;
};

function CategoryMultiSelect({
  categories,
  selected,
  setSelected
}: {
  categories: WorkforceCategoryOption[];
  selected: DesignationCategory[];
  setSelected: (value: DesignationCategory[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const deletedCategories = useMemo(
    () => selected.filter((value) => !categories.some((category) => category.code === value)),
    [categories, selected]
  );
  const summary = selected.length
    ? selected.map((category) => categories.find((option) => option.code === category)?.name ?? category).join(", ")
    : "Select categories";

  useEffect(() => {
    if (!open) return;

    function close(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function closeWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [open]);

  function toggle(value: DesignationCategory) {
    setSelected(selectedSet.has(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  return (
    <div className="multi-select" ref={rootRef}>
      <button
        className={`multi-select-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="multi-select-summary">{summary}</span>
        <ChevronDown aria-hidden="true" className="multi-select-chevron" size={16} strokeWidth={2.4} />
      </button>
      {open ? (
        <div className="multi-select-menu designation-category-menu">
          <div className="multi-select-options compact">
            {deletedCategories.map((category) => (
              <label className="multi-select-option" key={category}>
                <input
                  checked
                  className="matrix-checkbox"
                  onChange={() => toggle(category)}
                  type="checkbox"
                />
                <span>
                  <strong>{category}</strong>
                  <small>Deleted category - untick to remove</small>
                </span>
              </label>
            ))}
            {categories.map((category) => (
              <label className="multi-select-option" key={category.code}>
                <input
                  checked={selectedSet.has(category.code)}
                  className="matrix-checkbox"
                  onChange={() => toggle(category.code)}
                  type="checkbox"
                />
                <span><strong>{category.name}</strong></span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function FieldRuleMatrix({
  categoryRules,
  designationName = "Engagement type",
  fields,
  namePrefix,
  pageAccess = defaultAppPageAccess,
  rules,
  title
}: {
  categoryRules?: unknown;
  designationName?: string;
  fields: ProfileFieldRule[];
  namePrefix?: string;
  pageAccess?: string[];
  rules: ProfileFieldChannelRules;
  title: string;
}) {
  const [dropxOne, setDropxOne] = useState<ProfileFieldRuleSet>(rules.dropx_one);
  const [dashboard, setDashboard] = useState<ProfileFieldRuleSet>(rules.dashboard);

  function toggleRule(
    scope: ProfileFieldRuleSet,
    setScope: (value: ProfileFieldRuleSet) => void,
    key: string,
    type: "enabled" | "required"
  ) {
    const enabledSet = new Set(scope.enabled);
    const requiredSet = new Set(scope.required);
    if (type === "enabled") {
      if (enabledSet.has(key)) {
        enabledSet.delete(key);
        requiredSet.delete(key);
      } else {
        enabledSet.add(key);
      }
    } else if (requiredSet.has(key)) {
      requiredSet.delete(key);
    } else {
      enabledSet.add(key);
      requiredSet.add(key);
    }
    setScope({ enabled: Array.from(enabledSet), required: Array.from(requiredSet) });
  }

  const grouped = fields.reduce<Record<string, ProfileFieldRule[]>>((acc, field) => {
    acc[field.group] = [...(acc[field.group] ?? []), field];
    return acc;
  }, {});
  const effectiveRules = intersectProfileFieldChannelRules(
    normalizeCategoryProfileFieldRules(categoryRules),
    { dropx_one: dropxOne, dashboard }
  );

  return (
    <section className="designation-field-rules">
      {dropxOne.enabled.map((key) => <input key={`dropx-enabled-${key}`} name={`${namePrefix ? `${namePrefix}_` : ""}dropx_one_enabled_fields`} type="hidden" value={key} />)}
      {dropxOne.required.map((key) => <input key={`dropx-required-${key}`} name={`${namePrefix ? `${namePrefix}_` : ""}dropx_one_required_fields`} type="hidden" value={key} />)}
      {dashboard.enabled.map((key) => <input key={`dashboard-enabled-${key}`} name={`${namePrefix ? `${namePrefix}_` : ""}dashboard_enabled_fields`} type="hidden" value={key} />)}
      {dashboard.required.map((key) => <input key={`dashboard-required-${key}`} name={`${namePrefix ? `${namePrefix}_` : ""}dashboard_required_fields`} type="hidden" value={key} />)}
      <div className="designation-field-rules-head">
        <h3>{title}</h3>
        <p className="subtle">Configure visibility and required fields independently for DropX One and Dashboard.</p>
      </div>
      {Object.entries(grouped).map(([group, groupFields]) => (
        <div className="designation-rule-group" key={group}>
          <h4>{group}</h4>
          <div className="designation-rule-list">
            {groupFields.map((field) => (
              <div className="designation-rule-row" key={field.key}>
                <div className="designation-rule-name">
                  <strong>{field.label}</strong>
                  <small>{field.kind}</small>
                </div>
                {([
                  ["DropX One", dropxOne, setDropxOne],
                  ["Dashboard", dashboard, setDashboard]
                ] as const).map(([label, scope, setScope]) => (
                  <div className="designation-rule-channel" key={label}>
                    <strong>{label}</strong>
                    <label className="check-row">
                      <input
                        checked={scope.enabled.includes(field.key)}
                        className="matrix-checkbox"
                        onChange={() => toggleRule(scope, setScope, field.key, "enabled")}
                        type="checkbox"
                      />
                      <span>Enable</span>
                    </label>
                    <label className="check-row">
                      <input
                        checked={scope.required.includes(field.key)}
                        className="matrix-checkbox"
                        onChange={() => toggleRule(scope, setScope, field.key, "required")}
                        type="checkbox"
                      />
                      <span>Required</span>
                    </label>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
      <DropxOneDesignationPreview
        designationName={designationName}
        fields={fields}
        pageAccess={pageAccess}
        rules={effectiveRules}
        scopeLabel={title.replace(/ fields$/i, "")}
      />
    </section>
  );
}

function ModelMultiSelect({
  models,
  selected,
  setSelected
}: {
  models: ModelOption[];
  selected: string[];
  setSelected: (value: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filtered = useMemo(() => models.filter((model) => {
    const haystack = `${model.code} ${model.name} ${model.provider ?? ""}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  }), [models, query]);
  const selectedModels = models.filter((model) => selectedSet.has(model.id));
  const allFilteredSelected = filtered.length > 0 && filtered.every((model) => selectedSet.has(model.id));
  const summary = selectedModels.length
    ? `${selectedModels.length} selected`
    : models.length
      ? "Select models"
      : "No models added";

  useEffect(() => {
    if (!open) return;

    function close(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function closeWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  function toggle(id: string) {
    setSelected(selectedSet.has(id) ? selected.filter((value) => value !== id) : [...selected, id]);
  }

  function toggleAllFiltered() {
    if (allFilteredSelected) {
      const filteredIds = new Set(filtered.map((model) => model.id));
      setSelected(selected.filter((value) => !filteredIds.has(value)));
      return;
    }
    setSelected(Array.from(new Set([...selected, ...filtered.map((model) => model.id)])));
  }

  return (
    <div className="multi-select" ref={rootRef}>
      <button
        className={`multi-select-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span>{summary}</span>
        <ChevronDown aria-hidden="true" className="multi-select-chevron" size={16} strokeWidth={2.4} />
      </button>
      {open ? (
        <div className="multi-select-menu designation-model-menu">
          <div className="multi-select-search">
            <input
              className="field"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search model"
              value={query}
            />
            <button className="button secondary" onClick={() => setQuery("")} type="button">Clear</button>
          </div>
          <label className="multi-select-all">
            <input checked={allFilteredSelected} className="matrix-checkbox" onChange={toggleAllFiltered} type="checkbox" />
            <span>Check all filtered</span>
            <small>{filtered.length} shown</small>
          </label>
          <div className="multi-select-options">
            {filtered.length ? filtered.map((model) => (
              <label className="multi-select-option" key={model.id}>
                <input checked={selectedSet.has(model.id)} className="matrix-checkbox" onChange={() => toggle(model.id)} type="checkbox" />
                <span>
                  <strong>{model.code}</strong>
                  <small>{[model.name, model.provider].filter(Boolean).join(" - ")}</small>
                </span>
              </label>
            )) : <div className="searchable-empty">No models found</div>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function DesignationForm({
  action,
  businessCategories,
  categories,
  initial,
  models,
  peopleModule,
  roles,
  submitLabel = "Add designation"
}: {
  action: (formData: FormData) => void;
  businessCategories: DesignationBusinessCategory[];
  categories: WorkforceCategoryOption[];
  initial?: DesignationInitial | null;
  providers?: ProviderOption[];
  models: ModelOption[];
  peopleModule: DesignationBusinessCategory["people_module"] | null;
  roles: OnboardingRoleOption[];
  submitLabel?: string;
}) {
  const [selectedModels, setSelectedModels] = useState<string[]>(initial?.model_ids ?? []);
  const [selectedCategories, setSelectedCategories] = useState<DesignationCategory[]>(
    normalizeDesignationCategories(initial?.onboarding_categories)
  );
  const [designationName, setDesignationName] = useState(initial?.name ?? "");
  const [registrationCategory, setRegistrationCategory] = useState(() => {
    const initialCategories = normalizeDesignationCategories(initial?.onboarding_categories);
    const configured = String(initial?.registration_category_code ?? "");
    return initialCategories.includes(configured) ? configured : initialCategories[0] ?? "";
  });
  const [selectedPages, setSelectedPages] = useState<string[]>(() => (
    (initial?.app_page_access ?? defaultAppPageAccess)
      .filter((page) => appPageOptions.some((option) => option.value === page))
  ));
  const destinationOptions = designationProfileDestinationsForModule(peopleModule);
  const defaultDestination = inferDesignationProfileDestination({
    onboardingCategories: initial?.onboarding_categories,
    peopleModule,
    profileDestination: initial?.profile_destination
  });

  useEffect(() => {
    if (selectedCategories.includes(registrationCategory)) return;
    setRegistrationCategory(selectedCategories[0] ?? "");
  }, [registrationCategory, selectedCategories]);

  return (
    <form action={action} className="designation-form">
      {initial ? <input name="id" type="hidden" value={initial.id} /> : null}
      {selectedModels.map((modelId) => (
        <input key={modelId} name="model_ids" type="hidden" value={modelId} />
      ))}
      {selectedCategories.map((category) => (
        <input key={category} name="onboarding_categories" type="hidden" value={category} />
      ))}
      <div className="form-grid three">
        <label>
          Designation code
          <input className="field" defaultValue={initial?.code ?? ""} name="code" placeholder="Enter designation code" required />
        </label>
        <label>
          Designation name
          <input className="field" name="name" onChange={(event) => setDesignationName(event.target.value)} placeholder="Enter designation name" required value={designationName} />
        </label>
        <label>
          Engagement type
          <CategoryMultiSelect categories={categories} selected={selectedCategories} setSelected={setSelectedCategories} />
          <small>{peopleModule === "people_hr" ? "People/HR employee engagement only." : "Select a configured Workforce engagement type."}</small>
        </label>
        <label>
          Registration policy
          <select className="field" disabled={!selectedCategories.length} name="registration_category_code" onChange={(event) => setRegistrationCategory(event.target.value)} required value={registrationCategory}>
            {!selectedCategories.length ? <option value="">Select an engagement type first</option> : null}
            {selectedCategories.map((category) => <option key={category} value={category}>{categories.find((option) => option.code === category)?.name ?? category}</option>)}
          </select>
          <small>Controls registration requirements and DropX One access.</small>
        </label>
        <label>
          Models
          <ModelMultiSelect models={models} selected={selectedModels} setSelected={setSelectedModels} />
        </label>
        {peopleModule !== "people_hr" ? <label className="check-row designation-field-operations">
          <input
            className="matrix-checkbox"
            defaultChecked={Boolean(initial?.is_field_operations)}
            name="is_field_operations"
            type="checkbox"
          />
          <span>
            <strong>Field Operations</strong>
            <small>Include people with this designation in ID &amp; Pay Mapping.</small>
          </span>
        </label> : null}
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
      <section className="workforce-category-page-access designation-classification">
        <div>
          <strong>Designation classification</strong>
          <p className="subtle">People can select only HR categories and People-managed profile tables.</p>
        </div>
        <div className="designation-classification-fields">
          <label>
            HR category
            <select className="field" defaultValue={initial?.designation_category_id ?? (businessCategories.length === 1 ? businessCategories[0].id : "")} name="designation_category_id" required>
              <option value="">Select HR category</option>
              {businessCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </label>
          <label>
            Profile destination
            <select className="field" defaultValue={defaultDestination} name="profile_destination" required>
              {destinationOptions.map((option) => <option key={option.value} value={option.value}>{option.label} table</option>)}
            </select>
            <small>New and continuing registrations are written to this People table.</small>
          </label>
        </div>
      </section>
      <section className="workforce-category-page-access">
        <div>
          <strong>DropX One page access</strong>
          <p className="subtle">A page is available only when enabled for both this designation and its engagement type. My Profile and Settings are always available.</p>
        </div>
        <AppPageAccessSelect initialPages={selectedPages} onChange={setSelectedPages} />
      </section>
      <section className="workforce-category-page-access">
        <div>
          <strong>Onboarding Access</strong>
          <p className="subtle">Only users with the selected roles can onboard this designation. If no role is selected, only Owner or Master Owner can onboard it.</p>
        </div>
        <OnboardingRoleMultiSelect options={roles} selectedValues={initial?.onboarding_role_ids ?? []} />
      </section>
      <section className="workforce-category-page-access designation-portal-access">
        <div>
          <strong>Portal Access</strong>
          <p className="subtle">Choose which portals can add, view, or edit people assigned to this designation.</p>
        </div>
        <PortalAccessMatrix initialValue={initial?.portal_permissions} />
      </section>
      {!selectedCategories.length ? (
        <div className="designation-field-rule-empty">Select one or more engagement types.</div>
      ) : (
        <div className={`designation-field-rule-grid ${selectedCategories.length === 1 ? "single" : ""}`}>
          {selectedCategories.map((category) => {
            const categoryOption = categories.find((option) => option.code === category);
            const categoryPages = categoryOption?.app_page_access ?? defaultAppPageAccess;
            const effectivePages = selectedPages.filter((page) => categoryPages.includes(page));
            return <FieldRuleMatrix
              categoryRules={categoryOption?.profile_field_rules}
              designationName={designationName}
              fields={workforceProfileFields}
              key={category}
              namePrefix={category}
              pageAccess={effectivePages}
              rules={profileFieldRulesForCategory(initial?.profile_field_rules, category)}
              title={`${categories.find((option) => option.code === category)?.name ?? category} fields`}
            />;
          })}
        </div>
      )}
      <div className="form-actions right">
        <SubmitButton className="button" pendingText="Saving">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
