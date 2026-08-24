"use client";

import { useState } from "react";
import { Search, X } from "lucide-react";
import { TrackingDetailModal } from "@/components/tracking-detail-modal";

export function TrackingIdSearch() {
  const [value, setValue] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  function runSearch() {
    const trackingId = value.trim();
    if (!trackingId) return;
    setOpenId(trackingId);
  }

  function clearSearch() {
    setValue("");
    setOpenId(null);
  }

  return (
    <>
      <div className="tracking-search">
        <Search size={15} className="tracking-search-icon" aria-hidden="true" />
        <input
          type="search"
          className="tracking-search-input"
          placeholder="Search tracking ID…"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              runSearch();
            }
          }}
        />
        {value ? (
          <button type="button" className="tracking-search-clear" aria-label="Clear tracking ID search" onClick={clearSearch}>
            <X size={13} />
          </button>
        ) : null}
      </div>

      <TrackingDetailModal trackingId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}
