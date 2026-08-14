"use client";

import { useState } from "react";
import {
  BIOMETRIC_DEVICE_PROFILES,
  BIOMETRIC_MIDDLEWARE_HOST,
  BIOMETRIC_MIDDLEWARE_PORT,
  type BiometricDeviceModel,
  biometricDeviceProfile
} from "@/lib/biometric/device-profiles";

export function BiometricDeviceProfileFields({ defaultModel }: { defaultModel?: string | null }) {
  const initialProfile = biometricDeviceProfile(defaultModel) ?? BIOMETRIC_DEVICE_PROFILES[0];
  const [model, setModel] = useState(initialProfile.model);
  const profile = biometricDeviceProfile(model) ?? BIOMETRIC_DEVICE_PROFILES[0];

  return (
    <>
      <label>Device model
        <select className="select" name="model" value={model} onChange={(event) => setModel(event.target.value as BiometricDeviceModel)} required>
          {BIOMETRIC_DEVICE_PROFILES.map((option) => (
            <option key={option.model} value={option.model}>{option.label}</option>
          ))}
        </select>
      </label>

      <div className="span-3 helper-card biometric-profile-card" aria-live="polite">
        <strong>{profile.label}</strong>
        <div className="biometric-profile-grid">
          <span><small>Domain</small>{BIOMETRIC_MIDDLEWARE_HOST}</span>
          <span><small>Server port</small>{BIOMETRIC_MIDDLEWARE_PORT}</span>
          <span><small>Connector</small>{profile.protocol}</span>
          <span><small>Heartbeat</small>3 seconds</span>
        </div>
        <p>{profile.note}</p>
      </div>
    </>
  );
}
