"use client";

import { signInWithGoogle } from "@/app/login/actions";

type PeopleLoginPanelProps = {
  initialMessage?: string | null;
  nextPath?: string;
};

export function PeopleLoginPanel({ initialMessage, nextPath = "/" }: PeopleLoginPanelProps) {
  return (
    <main className="people-login-page">
      <section className="people-login-card" aria-label="Sign in to DropX People">
        <div className="people-login-brand">
          <img src="/dropx-logo.png" alt="DropX" />
          <span aria-hidden="true" />
          <strong>People</strong>
        </div>

        <div className="people-login-copy">
          <span>DROPX LOGISTICS</span>
          <h1>People operations, in one place.</h1>
          <p>Secure HRMS for employees, attendance, leave and approvals.</p>
        </div>

        {initialMessage ? <div className="people-login-notice" role="status">{initialMessage}</div> : null}

        <form action={signInWithGoogle}>
          <input name="next" type="hidden" value={nextPath} />
          <button className="people-google-login" type="submit">
            <img src="/google-g.svg" alt="" />
            Continue with DropX Google
          </button>
        </form>

        <p className="people-login-footnote">Only active users with an authorised DropX Google account can continue.</p>
      </section>
    </main>
  );
}
