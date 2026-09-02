"use client";

import { useState } from "react";
import { DirectActivationProfileFields } from "@/components/direct-activation-profile-fields";
import {
  ScopedDesignationFields,
  type ScopedDesignationOption,
  type ScopedLocationOption
} from "@/components/scoped-designation-fields";

export function DynamicWorkforceRegistrationFields({
  categoryDashboardRules,
  designationOptions,
  initialDesignation = "",
  initialLocationId = "",
  locationOptions
}: {
  categoryDashboardRules: { enabled: string[]; required: string[] };
  designationOptions: ScopedDesignationOption[];
  initialDesignation?: string | null;
  initialLocationId?: string | null;
  locationOptions: ScopedLocationOption[];
}) {
  const [designation, setDesignation] = useState(initialDesignation ?? "");
  const rules = designationOptions.find((option) => option.value === designation)?.dashboardRules
    ?? { enabled: [], required: [] };

  return <>
    <ScopedDesignationFields
      designationName="designation"
      designationOptions={designationOptions}
      initialDesignation={initialDesignation}
      initialLocationId={initialLocationId}
      locationName="location_id"
      locationOptions={locationOptions}
      onDesignationChange={setDesignation}
    />
    <DirectActivationProfileFields rules={rules} />
  </>;
}
