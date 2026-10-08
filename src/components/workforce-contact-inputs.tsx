"use client";

import type { ChangeEvent, InputHTMLAttributes } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";

import {
  STATION_EMAIL_EXCEPTION_NOTE_FIELD,
  STATION_EMAIL_EXCEPTION_NOTE_MAX,
  STATION_EMAIL_EXCEPTION_NOTE_MIN,
  workforceStationEmailError,
  workforceStationEmailExceptionNote,
  workforceStationEmailNeedsException
} from "@/lib/workforce-register-policy";

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
  const [value, setValue] = useState(() => digitsOnly(String(defaultValue ?? "")).slice(0, 10));

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setValue(digitsOnly(event.target.value).slice(0, 10));
  }

  return (
    <input
      {...props}
      autoComplete="tel-national"
      className={className}
      inputMode="numeric"
      maxLength={10}
      name={name}
      onChange={handleChange}
      pattern="[0-9]{10}"
      placeholder={placeholder}
      required={required}
      title="Enter a 10-digit mobile number"
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
  stationCode = "",
  requiresStationEmail = false,
  preserveExisting = false,
  ...props
}: SharedInputProps & { stationCode?: string; requiresStationEmail?: boolean; preserveExisting?: boolean }) {
  const [value, setValue] = useState(() => String(defaultValue ?? "").trim().toLowerCase());
  const [exceptionNote, setExceptionNote] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [askingForNote, setAskingForNote] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const exceptionNoteRef = useRef("");
  const submitterRef = useRef<HTMLElement | null>(null);
  const unchanged = preserveExisting && value === defaultValue.trim().toLowerCase();
  const error = value && !unchanged ? workforceStationEmailError(value, stationCode, requiresStationEmail) : null;
  // A valid address that only breaks the station-code rule does not block the
  // form: the mailbox may already be registered with the partner, so it can be
  // submitted with a written reason instead.
  const needsException = Boolean(value) && !unchanged && workforceStationEmailNeedsException(value, stationCode, requiresStationEmail);
  const blockingError = needsException ? null : error;
  const draftNote = workforceStationEmailExceptionNote(noteDraft);
  useEffect(() => { inputRef.current?.setCustomValidity(blockingError ?? ""); }, [blockingError, value]);
  // A reason belongs to one address at one station; changing either discards it.
  useEffect(() => { exceptionNoteRef.current = ""; setExceptionNote(""); }, [value, stationCode]);
  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form || !needsException) return;
    const askBeforeSubmit = (event: SubmitEvent) => {
      if (exceptionNoteRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      submitterRef.current = event.submitter;
      setNoteDraft("");
      setAskingForNote(true);
    };
    form.addEventListener("submit", askBeforeSubmit, true);
    return () => form.removeEventListener("submit", askBeforeSubmit, true);
  }, [needsException]);
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setValue(event.target.value.replace(/\s+/g, "").toLowerCase());
  }
  function blockingErrorFor(email: string) {
    if (unchanged || workforceStationEmailNeedsException(email, stationCode, requiresStationEmail)) return "";
    return workforceStationEmailError(email, stationCode, requiresStationEmail) ?? "";
  }
  function submitWithNote() {
    const form = inputRef.current?.form;
    if (!form || !draftNote) return;
    exceptionNoteRef.current = draftNote;
    flushSync(() => { setExceptionNote(draftNote); setAskingForNote(false); });
    const submitter = submitterRef.current;
    form.requestSubmit(submitter && submitter.isConnected ? submitter : undefined);
  }

  return (
    <>
    <input
      {...props}
      ref={inputRef}
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
        input.setCustomValidity(blockingError ?? (EMAIL_REGEX.test(input.value) ? "" : "Enter a valid email address."));
      }}
      onInput={(event) => event.currentTarget.setCustomValidity(blockingErrorFor(event.currentTarget.value))}
      pattern={EMAIL_PATTERN}
      placeholder={placeholder}
      required={required}
      aria-invalid={Boolean(error)}
      title={error || "Enter a valid email address"}
      type="email"
      value={value}
    />
    {needsException ? <input type="hidden" name={STATION_EMAIL_EXCEPTION_NOTE_FIELD} value={exceptionNote} readOnly /> : null}
    {error ? <small role="alert" style={{ color: needsException ? "#b54708" : "#b42318" }}>
      {error}{needsException ? (exceptionNote ? " reason added — this email will be saved as an exception." : " if this mailbox is already registered with the partner, submit and add a reason.") : null}
    </small> : null}
    {askingForNote ? createPortal(
      <div
        className="modal-backdrop"
        onKeyDown={(event) => { if (event.key === "Escape") setAskingForNote(false); }}
        style={{ zIndex: 60 }}
      >
        <div aria-labelledby="station-email-exception-title" aria-modal="true" className="modal-panel" role="dialog" style={{ width: "min(520px, 100%)" }}>
          <div style={{ display: "grid", gap: 10, padding: 16 }}>
            <strong id="station-email-exception-title">Use this email as an exception?</strong>
            <span><strong>{value}</strong> does not end with <strong>.{stationCode.toLowerCase()}</strong> before @. Add the reason it must be used, for example that the associate has already completed partner onboarding with this mailbox.</span>
            <textarea
              aria-label="Reason for using this email"
              autoFocus
              className="field"
              maxLength={STATION_EMAIL_EXCEPTION_NOTE_MAX}
              onChange={(event) => setNoteDraft(event.target.value)}
              placeholder="Reason for using this email"
              rows={4}
              value={noteDraft}
            />
            <small>At least {STATION_EMAIL_EXCEPTION_NOTE_MIN} characters. The reason is saved with your name.</small>
          </div>
          <div className="modal-actions" style={{ display: "flex", justifyContent: "flex-end" }}>
            <button className="button secondary" onClick={() => setAskingForNote(false)} type="button">Cancel</button>
            <button className="button" disabled={!draftNote} onClick={submitWithNote} type="button">Save reason and submit</button>
          </div>
        </div>
      </div>,
      document.body
    ) : null}
    </>
  );
}
