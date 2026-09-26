"use client";

import { LockKeyhole, ScanLine, ShieldCheck, Wrench } from "lucide-react";
import { signInWithGoogle } from "@/app/login/actions";
import { FleetBrand } from "@/components/fleet-brand";

export function FleetLoginPanel({ initialMessage, nextPath = "/" }: { initialMessage?: string | null; nextPath?: string }) {
  return (
    <main className="fleet-login-page">
      <section className="fleet-login-story" aria-label="DropX Fleet overview">
        <FleetBrand />
        <div className="fleet-login-copy">
          <span>VEHICLE OPERATIONS</span>
          <h1>Every vehicle.<br /><em>Ready to move.</em></h1>
          <p>Availability, service, audits and vehicle payments in one secure operating system.</p>
        </div>
        <div className="fleet-login-proof">
          <div><ScanLine size={19} /><span><strong>Audit-ready</strong><small>Risk-based vehicle inspection</small></span></div>
          <div><Wrench size={19} /><span><strong>Service intelligence</strong><small>History, due dates and costs</small></span></div>
          <div><ShieldCheck size={19} /><span><strong>Controlled access</strong><small>Role and station scoped</small></span></div>
        </div>
      </section>
      <section className="fleet-login-access">
        <div className="fleet-login-card">
          <div className="fleet-login-heading">
            <span><LockKeyhole size={20} /></span>
            <div><small>SECURE WORKSPACE</small><h2>Welcome back.</h2><p>Continue with your authorised DropX account.</p></div>
          </div>
          {initialMessage ? <div className="fleet-login-notice" role="status">{initialMessage}</div> : null}
          <form action={signInWithGoogle}>
            <input name="next" type="hidden" value={nextPath} />
            <button className="fleet-google-login" type="submit"><img src="/google-g.svg" alt="" />Continue with DropX Google</button>
          </form>
          <p className="fleet-login-footnote">Access is limited to active users enabled for Fleet operations.</p>
        </div>
        <p className="fleet-login-legal">DropX Fleet · Tropics Logistics vehicle operations</p>
      </section>
    </main>
  );
}
