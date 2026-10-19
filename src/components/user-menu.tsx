"use client";

import { ChevronDown, LogOut } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { SubmitButton } from "@/components/submit-button";

export function UserMenu({
  action,
  email,
  name,
  role
}: {
  action: (formData: FormData) => void | Promise<void>;
  email?: string | null;
  name: string;
  role?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    wrapperRef.current?.querySelector<HTMLButtonElement>(".user-menu-panel button")?.focus();
    function closeOnOutsideClick(event: PointerEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={wrapperRef} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-label={`Account menu for ${name}`}
        ref={triggerRef}
        className={`user-menu-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="user-avatar">{name.slice(0, 1).toUpperCase()}</span>
        <span className="user-menu-name">{name}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>

      {open ? (
        <div className="user-menu-panel" id={panelId} role="dialog" aria-label="Your account">
          <div className="user-menu-profile">
            <strong>{name}</strong>
            {role ? <span>{role}</span> : null}
            {email ? <small>{email}</small> : null}
          </div>
          <form action={action}>
            <SubmitButton className="user-menu-action" pendingText="Signing out">
              <LogOut size={15} aria-hidden="true" />
              Sign out
            </SubmitButton>
          </form>
        </div>
      ) : null}
    </div>
  );
}
