"use client";

import type { ChangeEvent, InputHTMLAttributes } from "react";
import { useEffect, useRef, useState } from "react";
import type { WorkforceContactFieldStatus, WorkforceContactRegister } from "@/lib/workforce-contact-availability";

const EMAIL_PATTERN = "[^\\s@]+@[^\\s@]+\\.[^\\s@]+";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function digitsOnly(value: string) {
  return value.replace(/\D+/g, "");
}

type SharedInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "defaultValue" | "name" | "onChange" | "type" | "value"
> & {
  defaultValue?: string;
  excludeId?: string | null;
  excludeRegister?: WorkforceContactRegister | null;
  name?: string;
};

const idleStatus: WorkforceContactFieldStatus = {
  status: "idle",
  message: "",
  match: null
};

function hintClass(status: WorkforceContactFieldStatus["status"]) {
  if (status === "available") return "field-hint success";
  if (status === "taken" || status === "invalid") return "field-hint error";
  return "field-hint";
}

function useContactAvailability(params: {
  kind: "mobile" | "email";
  value: string;
  enabled: boolean;
  excludeId?: string | null;
  excludeRegister?: WorkforceContactRegister | null;
}) {
  const [status, setStatus] = useState<WorkforceContactFieldStatus>(idleStatus);
  const requestId = useRef(0);

  useEffect(() => {
    if (!params.enabled) {
      setStatus(idleStatus);
      return;
    }

    const ready = params.kind === "mobile"
      ? /^\d{10}$/.test(params.value)
      : EMAIL_REGEX.test(params.value);

    if (!ready) {
      setStatus(idleStatus);
      return;
    }

    const currentRequest = ++requestId.current;
    setStatus({ status: "checking", message: "Checking database…", match: null });
    const timer = window.setTimeout(async () => {
      try {
        const query = new URLSearchParams({ [params.kind]: params.value });
        if (params.excludeId) query.set("excludeId", params.excludeId);
        if (params.excludeRegister) query.set("excludeRegister", params.excludeRegister);
        const response = await fetch(`/api/workforce/contact-availability?${query.toString()}`, {
          method: "GET",
          cache: "no-store"
        });
        const payload = await response.json().catch(() => ({}));
        if (currentRequest !== requestId.current) return;
        if (!response.ok) {
          setStatus({
            status: "invalid",
            message: String(payload.error ?? "Unable to check availability."),
            match: null
          });
          return;
        }
        const next = params.kind === "mobile" ? payload.mobile : payload.email;
        if (!next || typeof next !== "object") {
          setStatus(idleStatus);
          return;
        }
        setStatus({
          status: next.status,
          message: String(next.message ?? ""),
          match: next.match ?? null
        });
      } catch {
        if (currentRequest !== requestId.current) return;
        setStatus({
          status: "invalid",
          message: "Unable to check availability.",
          match: null
        });
      }
    }, 400);

    return () => window.clearTimeout(timer);
  }, [params.enabled, params.excludeId, params.excludeRegister, params.kind, params.value]);

  return status;
}

export function WorkforceMobileInput({
  className = "field",
  defaultValue = "",
  excludeId = null,
  excludeRegister = null,
  name = "mobile",
  placeholder = "Enter mobile number",
  required,
  ...props
}: SharedInputProps) {
  const [value, setValue] = useState(() => digitsOnly(String(defaultValue ?? "")).slice(0, 10));
  const availability = useContactAvailability({
    kind: "mobile",
    value,
    enabled: true,
    excludeId,
    excludeRegister
  });

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setValue(digitsOnly(event.target.value).slice(0, 10));
  }

  return (
    <div className="workforce-contact-field">
      <input
        {...props}
        autoComplete="tel-national"
        className={className}
        inputMode="numeric"
        maxLength={10}
        name={name}
        onChange={handleChange}
        onInvalid={(event) => {
          const input = event.currentTarget;
          if (!input.value.trim()) {
            input.setCustomValidity(required ? "Mobile number is required." : "");
            return;
          }
          if (!/^\d{10}$/.test(input.value)) {
            input.setCustomValidity("Enter a 10-digit mobile number.");
            return;
          }
          if (availability.status === "taken") {
            input.setCustomValidity(availability.message || "This mobile number is already registered.");
            return;
          }
          if (availability.status === "checking") {
            input.setCustomValidity("Please wait while we check this mobile number.");
            return;
          }
          input.setCustomValidity("");
        }}
        onInput={(event) => event.currentTarget.setCustomValidity("")}
        pattern="[0-9]{10}"
        placeholder={placeholder}
        required={required}
        title="Enter a 10-digit mobile number"
        type="text"
        value={value}
      />
      {availability.message ? <p className={hintClass(availability.status)}>{availability.message}</p> : null}
    </div>
  );
}

export function WorkforceEmailInput({
  className = "field",
  defaultValue = "",
  excludeId = null,
  excludeRegister = null,
  name = "email",
  placeholder = "Enter email",
  required,
  ...props
}: SharedInputProps) {
  const [value, setValue] = useState(() => String(defaultValue ?? "").trim().toLowerCase());
  const availability = useContactAvailability({
    kind: "email",
    value,
    enabled: true,
    excludeId,
    excludeRegister
  });

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setValue(event.target.value.replace(/\s+/g, "").toLowerCase());
  }

  return (
    <div className="workforce-contact-field">
      <input
        {...props}
        autoComplete="email"
        className={className}
        inputMode="email"
        name={name}
        onChange={handleChange}
        onInvalid={(event) => {
          const input = event.currentTarget;
          if (!input.value.trim()) {
            input.setCustomValidity(required ? "Email is required." : "");
            return;
          }
          if (!EMAIL_REGEX.test(input.value)) {
            input.setCustomValidity("Enter a valid email address.");
            return;
          }
          if (availability.status === "taken") {
            input.setCustomValidity(availability.message || "This email is already registered.");
            return;
          }
          if (availability.status === "checking") {
            input.setCustomValidity("Please wait while we check this email.");
            return;
          }
          input.setCustomValidity("");
        }}
        onInput={(event) => event.currentTarget.setCustomValidity("")}
        pattern={EMAIL_PATTERN}
        placeholder={placeholder}
        required={required}
        title="Enter a valid email address"
        type="email"
        value={value}
      />
      {availability.message ? <p className={hintClass(availability.status)}>{availability.message}</p> : null}
    </div>
  );
}
