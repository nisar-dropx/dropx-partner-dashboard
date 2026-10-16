"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, Copy, ExternalLink, Inbox, KeyRound, Mail, RefreshCw, ShieldCheck } from 'lucide-react';
import type { AppAccount } from './connect-profile-app';
import { mailCategory, type BetaMail, type BetaMailDetail } from '../lib/beta-inbox';
import styles from './connect-beta-inbox.module.css';

type Page = { email: string; messages: BetaMail[]; nextOffset: number | null; checkedAt: string };
const date = (value: string) => new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export function ConnectBetaInbox({ account }: { account: AppAccount }) {
  const [page, setPage] = useState<Page | null>(null), [mail, setMail] = useState<BetaMailDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [error, setError] = useState(''), [detailError, setDetailError] = useState('');
  const [busy, setBusy] = useState(false), [opening, setOpening] = useState(false), [copied, setCopied] = useState('');
  const [filter, setFilter] = useState('All');
  const inFlight = useRef(false), detailAbort = useRef<AbortController | null>(null);
  const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType }).toString();
  const refresh = useCallback(async (offset = 0) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      const response = await fetch(`/api/connect/beta-inbox?${query}&offset=${offset}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const next = await response.json(); if (!response.ok) throw new Error(next.error);
      setPage(old => offset && old ? { ...next, messages: [...new Map([...old.messages, ...next.messages].map(m => [m.id, m])).values()] } : next);
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Inbox unavailable. Please retry.'); }
    finally { inFlight.current = false; setBusy(false); }
  }, [query]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30000);
    return () => { window.clearInterval(timer); detailAbort.current?.abort(); };
  }, [refresh]);
  const open = async (id: string) => {
    detailAbort.current?.abort(); const controller = new AbortController(); detailAbort.current = controller;
    setSelected(id); setMail(null); setDetailError(''); setOpening(true);
    try {
      const response = await fetch(`/api/connect/beta-inbox?${query}&messageId=${id}`, { cache: 'no-store', signal: controller.signal });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      if (!controller.signal.aborted) setMail(result);
    } catch (reason) { if (!controller.signal.aborted) setDetailError(reason instanceof Error ? reason.message : 'Message unavailable.'); }
    finally { if (!controller.signal.aborted) setOpening(false); }
  };
  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(label); window.setTimeout(() => setCopied(''), 2500); }
    catch { setCopied('Copy unavailable. Select the text and copy it.'); }
  };
  const messages = (page?.messages ?? []).filter(m => filter === 'All' || mailCategory(m) === filter);
  return <section className={styles.inbox}>
    <header className={styles.heading}><div><small>YOUR PRIVATE BETA MAILBOX</small><h1>Mail inbox</h1><p>Amazon sign-in codes, password resets and IDfy updates.</p></div><button aria-label="Refresh inbox" disabled={busy} onClick={() => void refresh()}><RefreshCw size={19} className={busy ? styles.spin : undefined}/></button></header>
    <div className={styles.address}><Mail/><div><small>Your Amazon email</small><strong>{page?.email || 'Loading your address…'}</strong></div>{page?.email ? <button aria-label="Copy email address" onClick={() => void copy(page.email, 'Email copied')}><Copy size={17}/></button> : null}</div>
    <aside className={styles.help}><KeyRound size={20}/><p><b>Forgot your Amazon password?</b> Choose “Forgot password” in Amazon Flex, enter this email, then return here for the newest code or reset link. Request another code on Amazon if it hasn’t arrived.</p></aside>
    {copied ? <p role="status" className={styles.feedback}>{copied}</p> : null}
    {error ? <p role="alert" className={styles.error}>{error} <button onClick={() => void refresh()}>Retry</button></p> : null}
    <div className={`${styles.layout} ${selected ? styles.hasSelection : ''}`}>
      <div className={styles.listPanel}><div className={styles.tabs} role="group" aria-label="Filter messages">{['All', 'Account access', 'IDfy'].map(item => <button key={item} aria-pressed={filter === item} onClick={() => setFilter(item)}>{item}</button>)}</div>
        {!page && busy ? <p className={styles.empty} role="status">Checking your mailbox…</p> : !messages.length ? <div className={styles.empty}><Inbox/><b>{filter === 'All' ? 'Waiting for your first email' : 'No messages in this category'}</b><p>New messages appear here automatically. Keep this screen open while waiting for a code.</p></div> : <div className={styles.messages}>{messages.map(message => <button key={message.id} aria-pressed={selected === message.id} onClick={() => void open(message.id)}><i>{mailCategory(message) === 'Account access' ? <KeyRound size={18}/> : mailCategory(message) === 'IDfy' ? <ShieldCheck size={18}/> : <Mail size={18}/>}</i><span><small>{mailCategory(message)} · {date(message.received_at)}</small><strong>{message.subject || '(No subject)'}</strong><em>{message.sender}</em></span><ChevronRight size={16}/></button>)}</div>}
        {page?.nextOffset != null ? <button disabled={busy} className={styles.older} onClick={() => void refresh(page.nextOffset!)}>Load older emails</button> : null}
        <p className={styles.updated}>{page ? `Checked ${date(page.checkedAt)} · Refreshes every 30 seconds` : 'Only your assigned email is shown here.'}</p>
      </div>
      <article className={styles.detail} aria-label="Email contents">
        {selected ? <button className={styles.back} onClick={() => { detailAbort.current?.abort(); setSelected(null); setMail(null); }}><ArrowLeft size={17}/>All messages</button> : null}
        {opening ? <p role="status" className={styles.empty}>Opening email…</p> : detailError ? <div className={styles.error}>{detailError}<button onClick={() => selected && void open(selected)}>Retry</button></div> : mail ? <>
          <header><small>{date(mail.received_at)}</small><h2>{mail.subject || '(No subject)'}</h2><p>{mail.sender}</p></header>
          {mail.code ? <div className={styles.code}><div><small>Code from this email</small><strong>{mail.code}</strong></div><button onClick={() => void copy(mail.code!, 'Code copied')}><Copy size={16}/>Copy code</button></div> : null}
          {mailCategory(mail) === 'Account access' ? <p className={styles.note}>{mail.superseded?'A newer account-access email may be available. Return to the inbox and open the newest message.':'Use the newest email for your current request. Amazon decides when a code or reset link expires.'}</p> : null}
          {mail.links.length ? <div className={styles.actions}>{mail.links.map(link => <div key={link.url}><a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}<ExternalLink size={16}/></a><button aria-label={`Copy ${link.label.toLowerCase()}`} onClick={() => void copy(link.url, 'Link copied')}><Copy size={17}/></button></div>)}</div> : null}
          <div className={styles.body}>{mail.body || 'This message has no text content.'}</div>
          {mail.excerpt ? <p className={styles.note}>Saved email excerpt. The full message is temporarily unavailable.</p> : null}
        </> : <div className={styles.empty}><Mail/><b>Select an email</b><p>Your messages stay available here after registration.</p></div>}
      </article>
    </div>
  </section>;
}
