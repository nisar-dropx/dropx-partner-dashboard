"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { SearchableSelect, type SearchableSelectOption } from "@/components/searchable-select";

type ConfirmationSelect = {
  name: string;
  label: string;
  options: SearchableSelectOption[];
  placeholder: string;
  helper?: string;
};

type ConfirmationCheckbox = {
  name: string;
  label: string;
  defaultChecked?: boolean;
  value?: string;
};

export function SubmitButton({
  children,
  className = "button",
  disabled,
  disabledText,
  pendingText = "Saving",
  confirmMessage,
  confirmTitle = "Confirm deletion",
  confirmDescription = "Please review this action before continuing.",
  confirmCancelText = "Cancel",
  confirmSubmitText,
  confirmationSelect,
  confirmationCheckboxes,
  confirmationBlocked = false,
  form,
  name,
  value
}: {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  disabledText?: string;
  pendingText?: string;
  confirmMessage?: string;
  confirmTitle?: string;
  confirmDescription?: string;
  confirmCancelText?: string;
  confirmSubmitText?: string;
  confirmationSelect?: ConfirmationSelect;
  confirmationCheckboxes?: ConfirmationCheckbox[];
  confirmationBlocked?: boolean;
  form?: string;
  /** Set both to distinguish which of several submit buttons in one form was clicked (native button name/value semantics). */
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [confirmationSelection, setConfirmationSelection] = useState("");
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !pending) setConfirmationOpen(false);
    wasPending.current = pending;
  }, [pending]);

  useEffect(() => {
    if (!confirmationOpen) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) setConfirmationOpen(false);
    }

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [confirmationOpen, pending]);

  return (
    <>
      <button
        className={className}
        disabled={pending || disabled}
        form={form}
        name={name}
        value={value}
        onClick={(event) => {
          if (confirmMessage) {
            const form = event.currentTarget.form;
            if (form && !form.reportValidity()) return;
            setConfirmationSelection("");
            setConfirmationOpen(true);
          }
        }}
        type={confirmMessage ? "button" : "submit"}
      >
        {pending ? <span className="button-spinner" aria-hidden="true" /> : null}
        <span>{pending ? pendingText : disabled && disabledText ? disabledText : children}</span>
      </button>

      {confirmMessage && confirmationOpen ? (
        <div
          className="modal-backdrop confirmation-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !pending) setConfirmationOpen(false);
          }}
        >
          <section
            aria-labelledby="confirmation-title"
            aria-modal="true"
            className="modal-panel confirmation-dialog"
            role="alertdialog"
          >
            <div className="panel-head">
              <div>
                <h2 id="confirmation-title">{confirmTitle}</h2>
                <p className="subtle">{confirmDescription}</p>
              </div>
            </div>
            <div className="confirmation-body">
              <p>{confirmMessage}</p>
              {confirmationSelect ? (
                <label className="confirmation-select">{confirmationSelect.label}
                  <SearchableSelect
                    name={confirmationSelect.name}
                    onValueChange={setConfirmationSelection}
                    options={confirmationSelect.options}
                    placeholder={confirmationSelect.placeholder}
                    required
                  />
                  {confirmationSelect.helper ? <span className="subtle">{confirmationSelect.helper}</span> : null}
                </label>
              ) : null}
              {confirmationCheckboxes?.length ? (
                <div className="confirmation-checkbox-list">
                  {confirmationCheckboxes.map((checkbox) => (
                    <label className="confirmation-checkbox" key={checkbox.name}>
                      <input
                        defaultChecked={checkbox.defaultChecked}
                        name={checkbox.name}
                        type="checkbox"
                        value={checkbox.value ?? "true"}
                      />
                      <span>{checkbox.label}</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="form-actions modal-actions confirmation-actions">
              <button
                className="button secondary"
                disabled={pending}
                onClick={() => setConfirmationOpen(false)}
                type="button"
              >
                {confirmCancelText}
              </button>
              <button
                className={className}
                disabled={pending || confirmationBlocked || Boolean(confirmationSelect && !confirmationSelection)}
                form={form}
                name={name}
                value={value}
                type="submit"
              >
                {pending ? <span className="button-spinner" aria-hidden="true" /> : null}
                <span>{pending ? pendingText : confirmSubmitText ?? children}</span>
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
