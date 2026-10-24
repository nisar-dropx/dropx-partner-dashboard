"use client";

import { OpsPulseBrand } from "@/components/ops-pulse-brand";
import { OpsAppInstall } from "@/components/ops-app-install";
import { LockKeyhole } from "lucide-react";
import { signInWithGoogle } from "@/app/login/actions";

type OpsLoginPanelProps = {
  initialMessage?: string | null;
  nextPath?: string;
};

export function OpsLoginPanel({
  initialMessage,
  nextPath = "/",
}: OpsLoginPanelProps) {
  return (
    <main className="ops-login-page">
      <section className="ops-login-story" aria-label="OpsPulse overview">
        <div className="ops-login-brand">
          <img src="/dropx-logo.png" alt="DropX" />
          <span aria-hidden="true" />
          <OpsPulseBrand />
        </div>
        <div className="ops-login-story-copy">
          <h1>Your operations.<br />One clear view.</h1>
          <p>Stations, stores and teams. Together in OpsPulse.</p>
        </div>
      </section>

      <section className="ops-login-access" aria-label="Sign in to OpsPulse">
        <div className="ops-login-card">
          <div className="ops-login-card-heading">
            <span className="ops-login-card-icon">
              <LockKeyhole size={22} />
            </span>
            <div>
              <h2>Sign in to OpsPulse</h2>
              <p>Use your DropX Google account.</p>
            </div>
          </div>

          {initialMessage ? (
            <div className="ops-login-notice" role="status">
              {initialMessage}
            </div>
          ) : null}

          <form action={signInWithGoogle}>
            <input name="next" type="hidden" value={nextPath} />
            <button className="ops-google-login" type="submit">
              <img src="/google-g.svg" alt="" />
              Continue with DropX Google
            </button>
          </form>

          <p className="ops-access-footnote">
            Access managed by your organisation.
          </p>
        </div>

        <OpsAppInstall compact />
      </section>
    </main>
  );
}
