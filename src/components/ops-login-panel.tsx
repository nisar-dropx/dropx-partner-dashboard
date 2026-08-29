"use client";

import { useEffect, useState } from "react";
import { Download, LockKeyhole, MonitorSmartphone, ShieldCheck } from "lucide-react";
import { signInWithGoogle } from "@/app/login/actions";

type OpsLoginPanelProps = {
  initialMessage?: string | null;
  nextPath?: string;
};

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function OpsLoginPanel({ initialMessage, nextPath = "/" }: OpsLoginPanelProps) {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  async function installWebApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  return (
    <main className="ops-login-page">
      <section className="ops-login-story" aria-label="OpsPulse overview">
        <div className="ops-login-brand">
          <img src="/dropx-logo.png" alt="DropX" />
          <span aria-hidden="true" />
          <div>
            <strong>OpsPulse</strong>
            <small>Operations intelligence</small>
          </div>
        </div>
        <div className="ops-login-story-copy">
          <span className="ops-login-kicker">ONE OPERATING VIEW</span>
          <h1>Run every station from one clear pulse.</h1>
          <p>Performance, capacity, cash, fleet and action queues—secured to your assigned role and locations.</p>
        </div>
        <div className="ops-login-proof">
          <div><MonitorSmartphone size={20} /><span><strong>Built for every screen</strong><small>Phone, tablet and desktop</small></span></div>
          <div><ShieldCheck size={20} /><span><strong>Scope-safe by design</strong><small>Only your permitted operations</small></span></div>
        </div>
      </section>

      <section className="ops-login-access" aria-label="Sign in to OpsPulse">
        <div className="ops-login-card">
          <div className="ops-login-card-heading">
            <span className="ops-login-card-icon"><LockKeyhole size={22} /></span>
            <div>
              <span className="ops-login-kicker">SECURE ACCESS</span>
              <h2>Sign in to OpsPulse</h2>
              <p>Continue with your authorised DropX Google account.</p>
            </div>
          </div>

          {initialMessage ? <div className="ops-login-notice" role="status">{initialMessage}</div> : null}

          <form action={signInWithGoogle}>
            <input name="next" type="hidden" value={nextPath} />
            <button className="ops-google-login" type="submit">
              <img src="/google-g.svg" alt="" />
              Continue with DropX Google
            </button>
          </form>

          <p className="ops-access-footnote">Access is available only to active users enabled for OpsPulse.</p>
        </div>

        <div className="ops-app-downloads">
          <a className="ops-apk-download" href="/downloads/DropX-OpsPulse.apk" download>
            <Download size={18} />
            <span><strong>Download Android app</strong><small>Latest verified APK</small></span>
          </a>
          {installPrompt ? (
            <button type="button" onClick={() => void installWebApp()}>
              <MonitorSmartphone size={18} /> Install web app
            </button>
          ) : (
            <p>iPhone: open in Safari, tap Share, then “Add to Home Screen”.</p>
          )}
        </div>
      </section>
    </main>
  );
}
