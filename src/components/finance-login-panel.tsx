import Image from "next/image";
import { ArrowUpRight, Check, LockKeyhole } from "lucide-react";
import { signInWithGoogle } from "@/app/login/actions";
import { FinanceBrand } from "@/components/finance-brand";
import { SubmitButton } from "@/components/submit-button";

export function FinanceLoginPanel({ initialMessage, nextPath }: { initialMessage?: string; nextPath: string }) {
  return (
    <main className="fin-login">
      <header className="fin-masthead">
        <FinanceBrand />
        <span className="fin-workspace-label">THE FINANCE WORKSPACE</span>
      </header>
      <div className="fin-login-layout">
        <section className="fin-story" aria-labelledby="fin-story-title">
          <div className="fin-story-top"><span className="fin-eyebrow">PRECISION IN EVERY STEP</span><ArrowUpRight size={24} aria-hidden="true" /></div>
          <h1 id="fin-story-title">Every payment.<br /><em>Accounted for.</em></h1>
          <p className="fin-story-description">From the first approval to the final reconciliation. A clear view of the finances that keep DropX moving.</p>
          <div className="fin-ledger" aria-label="Finance workflow">
            <div className="fin-ledger-heading"><span>THE FLOW OF FINANCE</span><span>01 — 03</span></div>
            <div className="fin-ledger-row"><span className="fin-step">01</span><div><strong>Review with context</strong><p>Requests, supporting details and approvals.</p></div><Check size={18} aria-hidden="true" /></div>
            <div className="fin-ledger-row"><span className="fin-step">02</span><div><strong>Move payments forward</strong><p>Payment readiness and payout processing.</p></div><Check size={18} aria-hidden="true" /></div>
            <div className="fin-ledger-row"><span className="fin-step">03</span><div><strong>Bring the numbers together</strong><p>Reconciliation, reporting and financial oversight.</p></div><Check size={18} aria-hidden="true" /></div>
          </div>
          <div className="fin-story-footer"><span>DROPX LOGISTICS</span><span>Clarity. Control. Continuity.</span></div>
        </section>
        <section className="fin-access" aria-labelledby="fin-access-title">
          <div className="fin-access-content">
            <span className="fin-access-icon"><LockKeyhole size={23} strokeWidth={1.6} aria-hidden="true" /></span>
            <p className="fin-eyebrow">YOUR FINANCE WORKSPACE</p>
            <h2 id="fin-access-title">Welcome to Fin.</h2>
            <p className="fin-access-description">Sign in to manage approvals, payments and financial reporting.</p>
            {initialMessage ? <div className="fin-login-error" role="alert">{initialMessage}</div> : null}
            <form action={signInWithGoogle} className="fin-signin-form">
              <input type="hidden" name="next" value={nextPath} />
              <SubmitButton className="fin-google-button" pendingText="Opening Google…">
                <Image src="/google-signin-light.svg" alt="Sign in with Google" width={190} height={40} unoptimized />
              </SubmitButton>
            </form>
            <p className="fin-account-hint">Use the Google account authorised for your DropX Finance access.</p>
            <div className="fin-access-note"><LockKeyhole size={16} aria-hidden="true" /><p>Your role determines what you can view and manage. Need access? Contact your DropX administrator.</p></div>
          </div>
          <footer className="fin-access-footer"><span>Built for the business behind every delivery.</span><span>DropX · Fin</span></footer>
        </section>
      </div>
    </main>
  );
}
