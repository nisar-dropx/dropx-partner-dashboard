"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";
import { TrackingDetailModal } from "@/components/tracking-detail-modal";

/**
 * The Delivery Performance tracking-ID lookup, for the Losses header.
 * The detail modal is mounted on <body> so the Losses table and form styles
 * (scoped to the page container) cannot restyle it.
 */
export function LossTidSearch() {
  const [value, setValue] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <>
      <div className="tracking-search">
        <Search size={15} className="tracking-search-icon" aria-hidden="true" />
        <input
          type="search"
          className="tracking-search-input"
          placeholder="Search tracking ID…"
          aria-label="Search tracking ID"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (value.trim()) setOpenId(value.trim());
            }
          }}
        />
        {value ? (
          <button
            type="button"
            className="tracking-search-clear"
            aria-label="Clear tracking ID search"
            onClick={() => {
              setValue("");
              setOpenId(null);
            }}
          >
            <X size={13} />
          </button>
        ) : null}
      </div>
      {mounted
        ? createPortal(
            <TrackingDetailModal trackingId={openId} onClose={() => setOpenId(null)} />,
            document.body,
          )
        : null}
    </>
  );
}
