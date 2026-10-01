export function normalizeHelperBiometricId(value: unknown) {
  const normalized = String(value ?? "").trim().replace(/^0+(?=\d)/, "");
  return normalized || "0";
}

export function helperBiometricIdVariants(values: unknown[]) {
  return Array.from(new Set(values.flatMap((value) => {
    const raw = String(value ?? "").trim();
    if (!raw) return [];
    const normalized = normalizeHelperBiometricId(raw);
    return [raw, normalized, normalized.padStart(6, "0"), normalized.padStart(8, "0")];
  })));
}

export function uniqueHelperByBiometricId<T extends { id: string; biometric_id?: string | null }>(helpers: T[]) {
  const candidates = new Map<string, T[]>();
  for (const helper of helpers) {
    if (!String(helper.biometric_id ?? "").trim()) continue;
    const key = normalizeHelperBiometricId(helper.biometric_id);
    candidates.set(key, [...(candidates.get(key) ?? []), helper]);
  }
  return {
    helperByBiometricId: new Map([...candidates.entries()]
      .filter(([, matches]) => matches.length === 1)
      .map(([key, matches]) => [key, matches[0]])),
    duplicateBiometricIds: [...candidates.entries()]
      .filter(([, matches]) => matches.length > 1)
      .map(([key]) => key)
      .sort()
  };
}

export function biometricIdBelongsOnlyToProfile(
  personId: string,
  profileType: string,
  owners: Array<{ id: string; source: string }>
) {
  return owners.length === 1 && owners[0].source === profileType && owners[0].id === personId;
}
