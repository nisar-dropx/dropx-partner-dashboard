"use client";

import type { InputHTMLAttributes } from "react";
import { formatPersonNameInput } from "@/lib/person-name";

export function PersonNameInput({ onInput, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      autoCapitalize="characters"
      pattern="[A-Z ]+"
      title="Use uppercase letters and spaces only."
      onInput={(event) => {
        event.currentTarget.value = formatPersonNameInput(event.currentTarget.value);
        onInput?.(event);
      }}
    />
  );
}
