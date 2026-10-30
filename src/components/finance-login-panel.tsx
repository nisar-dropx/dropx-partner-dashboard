import { signInWithGoogle } from "@/app/login/actions";
import { SubmitButton } from "@/components/submit-button";
import { FinanceBrand } from "@/components/finance-brand";
import { FinanceInstall } from "@/components/finance-install";

export function FinanceLoginPanel({ message, nextPath }: { message?: string; nextPath: string }) {
  return <main className="finance-login">
    <section className="finance-login-story"><FinanceBrand />
      <span className="finance-kicker">YOUR BUSINESS, IN FOCUS</span>
      <h1>Clarity.<br />Down to the<br /><em>last rupee.</em></h1>
      <p>Revenue, costs and the story behind your profit. One connected workspace, wherever you work.</p>
      <div className="finance-login-features"><span>Live P&L</span><span>Every cost explained</span><span>Approvals & payments</span></div>
    </section>
    <section className="finance-login-card">
      <div className="finance-login-mobile-brand"><FinanceBrand /></div>
      <span className="finance-kicker">WELCOME BACK</span><h2>Your finance desk.<br />Ready when you are.</h2>
      <p>Sign in with your authorised Google account.</p>
      {message && <div className="login-error" role="alert">{message}</div>}
      <form className="google-signin-form" action={signInWithGoogle}>
        <input name="next" type="hidden" value={nextPath} />
        <SubmitButton className="google-asset-button" pendingText="Opening Google"><img className="google-signin-asset" src="/google-signin-light.svg" alt="Sign in with Google" /></SubmitButton>
      </form>
      <div className="finance-login-access">Your existing role and station access apply on every device.</div>
      <FinanceInstall />
    </section>
  </main>;
}
