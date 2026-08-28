"use client";

import { CalendarDays, ChevronRight, ClipboardCheck, LocateFixed, ReceiptText, Settings, ShieldCheck, SwitchCamera } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppAccount } from "./connect-profile-app";

type Counts = { leave: number; location: number; claims: number };

export function ConnectPeopleWorkspace({
  account,
  onApprovals,
  onSettings,
  onSwitch
}: {
  account: AppAccount;
  onApprovals: () => void;
  onSettings: () => void;
  onSwitch: () => void;
}) {
  const [counts, setCounts] = useState<Counts>({ leave: 0, location: 0, claims: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
    Promise.all([
      fetch(`/api/connect/approvals?${query}`, { cache: "no-store" }).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to load approvals.");
        return payload;
      }),
      fetch(`/api/connect/reimbursements?${query}`, { cache: "no-store" }).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to load claims.");
        return payload;
      })
    ]).then(([workflow, reimbursements]) => {
      if (cancelled) return;
      setCounts({
        leave: workflow.leaveApprovals?.length ?? 0,
        location: workflow.locationSupportPackages?.length ?? 0,
        claims: reimbursements.approvals?.length ?? 0
      });
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load manager workspace.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [account.companyId, account.id, account.profileType]);

  const pending = counts.leave + counts.location + counts.claims;
  const firstName = (account.name || "there").trim().split(/\s+/)[0];

  return <section className="dx-people-workspace">
    <header>
      <div><small>People workspace</small><h1>Welcome, {firstName}</h1><p>Manager actions assigned to your active reporting role.</p></div>
      <span><ShieldCheck /> Authorised</span>
    </header>
    {error ? <div className="dx-alert error">{error}</div> : null}
    <button className="dx-manager-priority" disabled={loading} onClick={onApprovals}>
      <i><ClipboardCheck /></i>
      <span><small>Approval inbox</small><strong>{loading ? "Checking…" : pending ? `${pending} awaiting action` : "You’re all caught up"}</strong></span>
      <ChevronRight />
    </button>
    <section className="dx-manager-counts" aria-label="Pending approvals">
      <button onClick={onApprovals}><CalendarDays /><strong>{counts.leave}</strong><small>Time off</small></button>
      <button onClick={onApprovals}><LocateFixed /><strong>{counts.location}</strong><small>Location</small></button>
      <button onClick={onApprovals}><ReceiptText /><strong>{counts.claims}</strong><small>Claims</small></button>
    </section>
    <section className="dx-manager-actions">
      <button onClick={onApprovals}><ClipboardCheck /><span><strong>Review approvals</strong><small>Open the consolidated manager inbox</small></span><ChevronRight /></button>
      <button onClick={onSwitch}><SwitchCamera /><span><strong>Switch workspace</strong><small>Move between People and Workforce roles</small></span><ChevronRight /></button>
      <button onClick={onSettings}><Settings /><span><strong>Account settings</strong><small>Default profile and secure sign-in</small></span><ChevronRight /></button>
    </section>
  </section>;
}
