"use client";

import { useState } from "react";
import { WorkforceEmailInput } from "@/components/workforce-contact-inputs";
import { SearchableSelect } from "@/components/searchable-select";

export type ScopedLocationOption = {
  value: string;
  label: string;
  helper?: string;
  modelId?: string | null;
  requiresStationEmail?: boolean;
};

export type ScopedDesignationOption = {
  value: string;
  label: string;
  code?: string;
  helper?: string;
  modelIds?: string[];
  dashboardRules?: { enabled: string[]; required: string[] };
};

function designationOptionsForLocation(
  locationId: string,
  locations: ScopedLocationOption[],
  designations: ScopedDesignationOption[]
) {
  if (!locationId) return [];
  const modelId = locations.find((location) => location.value === locationId)?.modelId ?? "";
  return designations.filter((designation) => {
    const modelIds = designation.modelIds ?? [];
    return !modelIds.length || (modelId ? modelIds.includes(modelId) : false);
  });
}

export function ScopedDesignationFields({
  designationName,
  designationOptions,
  initialDesignation = "",
  initialLocationId = "",
  locationName,
  locationOptions,
  onDesignationChange,
  required = true,
  email
}: {
  designationName: string;
  designationOptions: ScopedDesignationOption[];
  initialDesignation?: string | null;
  initialLocationId?: string | null;
  locationName: string;
  locationOptions: ScopedLocationOption[];
  onDesignationChange?: (value: string) => void;
  required?: boolean;
  email?: { defaultValue?: string; required?: boolean; preserveExisting?: boolean };
}) {
  const [selectedLocationId, setSelectedLocationId] = useState(initialLocationId ?? "");
  const [selectedDesignation, setSelectedDesignation] = useState(initialDesignation ?? "");
  const filteredDesignationOptions = designationOptionsForLocation(selectedLocationId, locationOptions, designationOptions);
  const effectiveDesignationOptions = selectedDesignation && !filteredDesignationOptions.some((option) => option.value === selectedDesignation)
    ? [{ value: selectedDesignation, label: selectedDesignation, helper: "Current", modelIds: [] }, ...filteredDesignationOptions]
    : filteredDesignationOptions;
  const designationDisabled = !selectedLocationId || !effectiveDesignationOptions.length;

  const location = locationOptions.find(option => option.value === selectedLocationId);
  return (
    <>
      {email ? <label>Email<WorkforceEmailInput defaultValue={email.defaultValue} required={email.required} stationCode={location?.label} requiresStationEmail={location?.requiresStationEmail} preserveExisting={email.preserveExisting && selectedLocationId === initialLocationId} /></label> : null}
      <label>Location
        <SearchableSelect
          name={locationName}
          onValueChange={(value) => {
            setSelectedLocationId(value);
            setSelectedDesignation("");
            onDesignationChange?.("");
          }}
          options={locationOptions}
          placeholder="Select location"
          required={required}
          value={selectedLocationId}
        />
      </label>

      <label>Designation
        <SearchableSelect
          disabled={designationDisabled}
          name={designationName}
          onValueChange={(value) => {
            setSelectedDesignation(value);
            onDesignationChange?.(value);
          }}
          options={effectiveDesignationOptions}
          placeholder={selectedLocationId ? "Select designation" : "Select location first"}
          required={required && !designationDisabled}
          value={selectedDesignation}
        />
      </label>
      {email ? <div className="span-3 workforce-email-guidance" role="note">{location?.requiresStationEmail ? <>For Amazon EDSP, XPT and AMXL, use a mailbox ending in <strong>.{location.label}</strong> before @. Example: <strong>Akshay.{location.label}@outlook.com</strong>. Any email domain is allowed.</> : location ? <>Any valid email address can be used for this location.</> : <>Amazon EDSP, XPT and AMXL require .STATIONCODE before @ (for example Akshay.KOZA@outlook.com). Flipkart locations accept any valid email. Select a location to see its requirement.</>}</div> : null}
    </>
  );
}
