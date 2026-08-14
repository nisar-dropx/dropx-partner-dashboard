export const BIOMETRIC_MIDDLEWARE_HOST = "bio.dropxlogistics.com";
export const BIOMETRIC_MIDDLEWARE_PORT = 6010;

export const BIOMETRIC_DEVICE_PROFILES = [
  {
    model: "D01",
    label: "D01 - Dynamic face device",
    protocol: "D01 binary push",
    deviceLocalPort: 5005,
    note: "Use domain name Yes. The Server IP field can remain locked because DNS supplies the live address."
  },
  {
    model: "Z200BW",
    label: "Z200BW - Fingerprint device",
    protocol: "XML push",
    deviceLocalPort: 5005,
    note: "Use the existing XML push configuration."
  },
  {
    model: "Z305",
    label: "Z305 - Fingerprint device",
    protocol: "XML push",
    deviceLocalPort: 5005,
    note: "Use the existing XML push configuration."
  }
] as const;

export type BiometricDeviceModel = typeof BIOMETRIC_DEVICE_PROFILES[number]["model"];

export function biometricDeviceProfile(value: unknown) {
  const model = String(value ?? "").trim().toUpperCase();
  return BIOMETRIC_DEVICE_PROFILES.find((profile) => profile.model === model) ?? null;
}
