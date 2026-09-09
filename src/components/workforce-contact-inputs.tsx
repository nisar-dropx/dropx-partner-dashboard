"use client";

import type { ChangeEvent, InputHTMLAttributes } from "react";
import { useState } from "react";

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
  name?: string;
};

export function WorkforceMobileInput({
  className = "field",
  defaultValue = "",
  name = "mobile",
  placeholder = "Enter mobile number",
  required,
  ...props
}: SharedInputProps) {
  const [value, setValue] = useState(() => digitsOnly(String(defaultValue ?? "")).slice(0, 15));

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setValue(digitsOnly(event.target.value).slice(0, 15));
  }

  return (
    <input
      {...props}
      autoComplete="tel-national"
      className={className}
      inputMode="numeric"
      maxLength={15}
      name={name}
      onChange={handleChange}
      pattern="[0-9]{6,15}"
      placeholder={placeholder}
      required={required}
      title="Enter 6 to 15 digits"
      type="text"
      value={value}
    />
  );
}

export function WorkforceEmailInput({
  className = "field",
  defaultValue = "",
  name = "email",
  placeholder = "Enter email",
  required,
  ...props
}: SharedInputProps) {
  const [value, setValue] = useState(() => String(defaultValue ?? "").trim().toLowerCase());

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setValue(event.target.value.replace(/\s+/g, "").toLowerCase());
  }

  return (
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
        input.setCustomValidity(EMAIL_REGEX.test(input.value) ? "" : "Enter a valid email address.");
      }}
      onInput={(event) => event.currentTarget.setCustomValidity("")}
      pattern={EMAIL_PATTERN}
      placeholder={placeholder}
      required={required}
      title="Enter a valid email address"
      type="email"
      value={value}
    />
  );
}
