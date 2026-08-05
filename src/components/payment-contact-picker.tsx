"use client";

import { BadgeCheck, Landmark, Search, Smartphone } from "lucide-react";
import { SearchableSelect } from "@/components/searchable-select";
import type { UserPaymentContact } from "@/lib/payment-contacts";

type PaymentContactPickerProps = {
  contacts: UserPaymentContact[];
  disabled?: boolean;
  mode: "bank" | "upi";
  onValueChange: (value: string) => void;
  selectedId?: string;
};

export function PaymentContactPicker({ contacts, disabled, mode, onValueChange, selectedId }: PaymentContactPickerProps) {
  const selected = contacts.find((contact) => contact.id === selectedId);
  const isUpi = mode === "upi";
  const title = isUpi ? "Saved UPI beneficiary" : "Saved bank beneficiary";
  const Icon = isUpi ? Smartphone : Landmark;
  const primaryDetail = isUpi ? selected?.upi_id : selected?.bank_account_no;
  const secondaryDetail = isUpi ? selected?.contact_no || selected?.email : selected?.ifsc;

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
              ? [contact.upi_id, contact.contact_no, contact.email].filter(Boolean).join(" · ")
              : [contact.bank_account_no, contact.ifsc, contact.contact_no].filter(Boolean).join(" · ")
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
            <small>{[primaryDetail, secondaryDetail].filter(Boolean).join(" · ")}</small>
          </span>
          <span className="payment-contact-verified"><BadgeCheck aria-hidden="true" size={15} /> Verified</span>
        </div>
      ) : null}
    </div>
  );
}
