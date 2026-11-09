"use client";

import { BadgeCheck, Landmark, Search, Smartphone, Trash2 } from "lucide-react";
import { useState } from "react";
import { SearchableSelect } from "@/components/searchable-select";
import type { UserPaymentContact } from "@/lib/payment-contacts";

type PaymentContactPickerProps = {
  contacts: UserPaymentContact[];
  disabled?: boolean;
  mode: "bank" | "upi";
  onDeleted?: (contactId: string) => void;
  onValueChange: (value: string) => void;
  selectedId?: string;
};

export function PaymentContactPicker({ contacts, disabled, mode, onDeleted, onValueChange, selectedId }: PaymentContactPickerProps) {
  const [pendingDelete, setPendingDelete] = useState<UserPaymentContact | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const selected = contacts.find((contact) => contact.id === selectedId);
  const isUpi = mode === "upi";
  const title = isUpi ? "Saved UPI beneficiary" : "Saved bank beneficiary";
  const Icon = isUpi ? Smartphone : Landmark;
  const primaryDetail = isUpi ? selected?.upi_id : selected?.bank_account_no;
  const secondaryDetail = isUpi ? selected?.contact_no || selected?.email : selected?.ifsc;

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const response = await fetch(`/api/payments/contacts/${pendingDelete.id}`, { method: "DELETE" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Unable to delete saved beneficiary.");
      onDeleted?.(pendingDelete.id);
      if (selectedId === pendingDelete.id) onValueChange("");
      setPendingDelete(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Unable to delete saved beneficiary.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className={`payment-contact-picker ${selected ? "selected" : ""}`}>
      <div className="payment-contact-picker-head">
        <span className="payment-contact-picker-icon"><Icon aria-hidden="true" size={17} /></span>
        <span>
          <strong>{title}</strong>
          <small>Search and reuse a beneficiary you verified earlier</small>
        </span>
        <span className="payment-contact-picker-count">{contacts.length} saved</span>
      </div>
      <div className="payment-contact-picker-search">
        <Search aria-hidden="true" size={17} />
        <SearchableSelect
          disabled={disabled || !contacts.length}
          name={isUpi ? "saved_upi_contact_id" : "saved_bank_contact_id"}
          onValueChange={onValueChange}
          options={contacts.map((contact) => ({
            value: contact.id,
            label: contact.account_holder_name,
            helper: isUpi
              ? [`UPI: ${contact.upi_id}`, contact.contact_no ? `Phone: ${contact.contact_no}` : null, contact.email ? `Email: ${contact.email}` : null].filter(Boolean).join(" · ")
              : [`A/C: ${contact.bank_account_no}`, `IFSC: ${contact.ifsc}`, contact.contact_no ? `Phone: ${contact.contact_no}` : null].filter(Boolean).join(" · ")
          }))}
          placeholder={contacts.length ? "Search by name, account, UPI ID or phone" : `No saved ${isUpi ? "UPI" : "bank"} contacts`}
          value={selectedId ?? ""}
        />
      </div>
      {selected ? (
        <div className="payment-contact-picker-selection">
          <span className="payment-contact-avatar">{selected.account_holder_name.slice(0, 1).toUpperCase()}</span>
          <span className="payment-contact-selected-copy">
            <strong>{selected.account_holder_name}</strong>
            <small>{isUpi
              ? `UPI: ${primaryDetail ?? "-"}${secondaryDetail ? ` · ${secondaryDetail}` : ""}`
              : `A/C: ${primaryDetail ?? "-"} · IFSC: ${secondaryDetail ?? "-"}`}</small>
          </span>
          <span className="payment-contact-verified"><BadgeCheck aria-hidden="true" size={15} /> Verified</span>
        </div>
      ) : null}
      {contacts.length ? (
        <ul className="payment-contact-picker-list" aria-label={`Saved ${isUpi ? "UPI" : "bank"} beneficiaries`}>
          {contacts.map((contact) => {
            const detail = isUpi
              ? `UPI: ${contact.upi_id ?? "-"}`
              : `A/C: ${contact.bank_account_no ?? "-"} · IFSC: ${contact.ifsc ?? "-"}`;
            return (
              <li className={`payment-contact-picker-item ${contact.id === selectedId ? "active" : ""}`} key={contact.id}>
                <button
                  className="payment-contact-picker-item-select"
                  disabled={disabled}
                  onClick={() => onValueChange(contact.id)}
                  type="button"
                >
                  <strong>{contact.account_holder_name}</strong>
                  <small>{detail}</small>
                </button>
                <button
                  aria-label={`Delete ${contact.account_holder_name}`}
                  className="payment-contact-picker-delete"
                  disabled={disabled || deleting}
                  onClick={() => {
                    setDeleteError("");
                    setPendingDelete(contact);
                  }}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={15} />
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {pendingDelete ? (
        <div
          className="modal-backdrop confirmation-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleting) setPendingDelete(null);
          }}
        >
          <section aria-modal="true" className="modal-panel confirmation-dialog" role="alertdialog">
            <div className="panel-head">
              <div>
                <h2>Delete saved beneficiary?</h2>
                <p className="subtle">This removes the saved account from your Payment Requests list only.</p>
              </div>
            </div>
            <div className="confirmation-body">
              <p>
                Delete <strong>{pendingDelete.account_holder_name}</strong>
                {isUpi
                  ? ` · UPI ${pendingDelete.upi_id ?? "-"}`
                  : ` · A/C ${pendingDelete.bank_account_no ?? "-"} · IFSC ${pendingDelete.ifsc ?? "-"}`}
                ?
              </p>
              <p className="subtle">Past payment requests keep their bank details. This cannot be undone.</p>
              {deleteError ? <div className="modal-inline-message warn"><strong>{deleteError}</strong></div> : null}
            </div>
            <div className="form-actions modal-actions confirmation-actions">
              <button className="button secondary" disabled={deleting} onClick={() => setPendingDelete(null)} type="button">
                Cancel
              </button>
              <button className="button payment-reject-button" disabled={deleting} onClick={confirmDelete} type="button">
                {deleting ? "Deleting…" : "Confirm delete"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
