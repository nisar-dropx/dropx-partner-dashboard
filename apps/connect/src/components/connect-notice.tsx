"use client";

import { useEffect, useRef } from "react";
import { Bell, ChevronRight, X } from "lucide-react";
import type { ConnectNotification } from "../lib/dashboard-notices";
import styles from "./connect-notice.module.css";
import { AnnouncementBody } from "./announcement-body";

export function ConnectNoticeCards({ notices, onOpen }: { notices: ConnectNotification[]; onOpen: (notice: ConnectNotification) => void }) {
  if (!notices.length) return null;
  return <section className={styles.cards} aria-label="Latest notices">{notices.map(notice => <button type="button" className={styles.card} key={notice.id} onClick={() => onOpen(notice)}>
    <Bell size={22}/><span><small>{notice.read_at ? "NOTICE" : "NEW NOTICE"}</small><strong>{notice.title}</strong><span>{notice.data?.summary || "Open for details"}</span></span><ChevronRight size={20}/>
  </button>)}</section>;
}

export function ConnectNoticeDialog({ notice, onClose, onContinue }: { notice: ConnectNotification; onClose: () => void; onContinue: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="connect-notice-title" onClose={onClose}>
    <header><div><small>DROPX UPDATE</small><h2 id="connect-notice-title">{notice.title}</h2></div><button type="button" aria-label="Close notice" onClick={onClose}><X size={20}/></button></header>
    <div className={styles.body}><AnnouncementBody body={notice.body} presentation={notice.data?.presentation} /></div>
    <footer><button type="button" onClick={onClose}>Close</button><button type="button" className={styles.primary} onClick={onContinue}>{notice.data?.ctaLabel || "View details"}<ChevronRight size={17}/></button></footer>
  </dialog>;
}
