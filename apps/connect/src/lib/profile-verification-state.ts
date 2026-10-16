export type InputBoundVerification = {
  inputKey: string;
};

export type ExpiryBoundVerification = InputBoundVerification & {
  expiryDate?: string;
  registrationExpiryDate?: string;
  insuranceExpiryDate?: string;
  pollutionExpiryDate?: string;
};

export type ProfileVerificationExpiryValues = {
  drivingLicenseExpiry: string;
  registrationExpiry: string;
  insuranceExpiry: string;
  pollutionExpiry: string;
};

export type ProfileEditVerificationKind =
  | "pan"
  | "pan_aadhaar"
  | "bank"
  | "pf_uan"
  | "dl"
  | "vehicle";

export type ProfileEditVerificationRequirement = {
  kind: ProfileEditVerificationKind;
  label: string;
};

/**
 * Build the verification plan from changed fields and the final stored values.
 * Some designations hide one half of a verification pair, but the database
 * still retains that value. The plan deliberately considers those saved hidden
 * counterparts so the user can complete the required check before OTP.
 */
export function profileEditVerificationPlan({
  values,
  originalValues,
  requirePfUan = false
}: {
  values: Record<string, string | undefined>;
  originalValues: Record<string, string | undefined>;
  requirePfUan?: boolean;
}) {
  const changed = (...keys: string[]) => keys.some(
    (key) => (values[key] ?? "") !== (originalValues[key] ?? "")
  );
  const present = (key: string) => Boolean(values[key]?.trim());
  const panChanged = changed("panNumber");
  const panOrAadhaarChanged = changed("panNumber", "aadhaarNumber");
  const bankChanged = changed("bankAccountNo", "ifsc");
  const drivingIdentityChanged = changed("drivingLicenseNo", "dateOfBirth");

  let error = "";
  if (panOrAadhaarChanged && present("aadhaarNumber") && !present("panNumber")) {
    error = "PAN is required when an Aadhaar number is provided.";
  } else if (bankChanged && present("bankAccountNo") !== present("ifsc")) {
    error = "Bank account number and IFSC must be provided together.";
  } else if (drivingIdentityChanged && present("drivingLicenseNo") && !present("dateOfBirth")) {
    error = "Date of birth is required to verify the driving licence.";
  }

  const requirements: ProfileEditVerificationRequirement[] = [
    ...(panChanged && present("panNumber") ? [{ kind: "pan" as const, label: "PAN" }] : []),
    ...(panOrAadhaarChanged && present("panNumber") && present("aadhaarNumber")
      ? [{ kind: "pan_aadhaar" as const, label: "Aadhaar number" }]
      : []),
    ...(bankChanged && present("bankAccountNo") && present("ifsc")
      ? [{ kind: "bank" as const, label: "Bank account" }]
      : []),
    ...(changed("pfUan") && present("pfUan") && requirePfUan
      ? [{ kind: "pf_uan" as const, label: "PF UAN" }]
      : []),
    ...(drivingIdentityChanged && present("drivingLicenseNo")
      ? [{ kind: "dl" as const, label: "Driving license no" }]
      : []),
    ...(changed("vehicleRegistrationNo") && present("vehicleRegistrationNo")
      ? [{ kind: "vehicle" as const, label: "Vehicle reg no" }]
      : [])
  ];

  return {
    error,
    requirements,
    panChanged,
    panAadhaarDependency: requirements.some(({ kind }) => kind === "pan_aadhaar"),
    bankDependency: requirements.some(({ kind }) => kind === "bank"),
    drivingLicenseDependency: requirements.some(({ kind }) => kind === "dl")
  };
}

export function matchingProfileVerification<T extends InputBoundVerification>({
  inputKey,
  editing,
  fresh,
  baseline
}: {
  inputKey: string;
  editing: boolean;
  fresh?: T;
  baseline?: T;
}) {
  if (fresh?.inputKey === inputKey) return fresh;
  if (editing && baseline?.inputKey === inputKey) return baseline;
  return undefined;
}

/**
 * Returns the expiry fields that belong to the identifier currently in the
 * form. A matching verification is authoritative. If an edit is reverted to
 * the original identifier and no verified expiry is available, the original
 * persisted values are restored instead of leaving the derived fields blank.
 */
export function profileVerificationExpiryPatch({
  kind,
  inputKey,
  originalInputKey,
  editing,
  fresh,
  baseline,
  originalValues
}: {
  kind: "dl" | "vehicle";
  inputKey: string;
  originalInputKey: string;
  editing: boolean;
  fresh?: ExpiryBoundVerification;
  baseline?: ExpiryBoundVerification;
  originalValues: ProfileVerificationExpiryValues;
}): Partial<ProfileVerificationExpiryValues> {
  const verification = matchingProfileVerification({
    inputKey,
    editing,
    fresh,
    baseline
  });
  const reverted = editing && inputKey === originalInputKey;

  if (kind === "dl") {
    return {
      drivingLicenseExpiry:
        verification?.expiryDate || (reverted ? originalValues.drivingLicenseExpiry : "")
    };
  }

  return {
    registrationExpiry:
      verification?.registrationExpiryDate || (reverted ? originalValues.registrationExpiry : ""),
    insuranceExpiry:
      verification?.insuranceExpiryDate || (reverted ? originalValues.insuranceExpiry : ""),
    pollutionExpiry:
      verification?.pollutionExpiryDate || (reverted ? originalValues.pollutionExpiry : "")
  };
}
