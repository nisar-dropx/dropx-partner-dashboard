"use client";
import "./fleet-mobile-controls.css";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/** Progressive disclosure on phones; the desktop content and form state stay intact. */
export function FleetMobileSection({ title, summary, children, className = "", initiallyOpen = false }: {
  title: string; summary?: string; children: ReactNode; className?: string; initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const id = useId();
  return <section className={`fc-mobile-section ${className}`} data-open={open}>
    <button className="fc-mobile-section-toggle" type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <span><strong>{title}</strong>{summary ? <small>{summary}</small> : null}</span><ChevronDown size={17}/>
    </button>
    <div id={id} className="fc-mobile-section-content">{children}</div>
  </section>;
}
