"use client";

import type { ChangeEvent, InputHTMLAttributes } from "react";
import { useState } from "react";

function normalizeFullNameInput(value: string) {
  return value.replace(/[^A-Za-z ]+/g, "").replace(/\s{2,}/g, " ").toUpperCase();
}

type WorkforceFullNameInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "defaultValue" | "name" | "onChange" | "type" | "value"
> & {
  defaultValue?: string;
  name?: string;
};

export function WorkforceFullNameInput({
  className = "field",
  defaultValue = "",
  name = "full_name",
  placeholder = "Enter full name",
  required,
  ...props
}: WorkforceFullNameInputProps) {
  const [value, setValue] = useState(() => normalizeFullNameInput(String(defaultValue ?? "")));

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setValue(normalizeFullNameInput(event.target.value));
  }

  return (
    <input
      {...props}
      autoCapitalize="characters"
      autoComplete="name"
      className={className}
      inputMode="text"
      name={name}
      onChange={handleChange}
      pattern="[A-Za-z]+( [A-Za-z]+)*"
      placeholder={placeholder}
      required={required}
      spellCheck={false}
      title="Letters and spaces only"
      type="text"
      value={value}
    />
  );
}
