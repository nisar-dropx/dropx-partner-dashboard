"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Activity, ArrowDownToLine, ArrowRight, Boxes, CircleCheck, Download, LockKeyhole, MonitorSmartphone, ShieldCheck, Truck, Wallet } from "lucide-react";
import { OpsPulseBrand } from "@/components/ops-pulse-brand";
import { signInWithGoogle } from "@/app/login/actions";
import styles from "./ops-login-panel.module.css";

type OpsLoginPanelProps = { initialMessage?: string | null; nextPath?: string };
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function GoogleSignInButton() {
  const { pending } = useFormStatus();
  return (
    <button className={styles.googleButton} type="submit" disabled={pending} aria-busy={pending}>
      <Image src="/google-g.svg" alt="" width={20} height={20} />
      <span>{pending ? "Opening Google…" : "Continue with Google"}</span>
      <ArrowRight size={18} aria-hidden="true" />
    </button>
  );
}

export function OpsLoginPanel({ initialMessage, nextPath = "/" }: OpsLoginPanelProps) {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [installError, setInstallError] = useState("");

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
    setInstallError("");
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } catch {
      setInstallError("Installation could not open. Use your browser’s install menu, or try again later.");
    } finally {
      setInstallPrompt(null);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.masthead}>
        <div className={styles.brand}>
          <Image className={styles.parentLogo} src="/dropx-logo.png" alt="DropX" width={112} height={48} priority />
          <OpsPulseBrand />
        </div>
        <span className={styles.headerNote}><span aria-hidden="true" />THE OPERATIONS WORKSPACE</span>
      </header>
      <div className={styles.layout}>
        <section className={styles.story} aria-labelledby="ops-overview-title">
          <p className={styles.eyebrow}><span aria-hidden="true" /> SEE THE WHOLE PICTURE</p>
          <h1 id="ops-overview-title">Every station.<br />Every move.<br /><span>One clear pulse.</span></h1>
          <p className={styles.intro}>Bring your daily operations into focus.<br className={styles.desktopBreak} /> Know what needs attention. Keep your teams moving.</p>
          <div className={styles.overview} role="group" aria-label="OpsPulse brings four operational areas into one action view">
            <div className={styles.overviewTop}><span>CONNECTED OPERATIONS</span><span className={styles.overviewCaption}>A single operating view</span></div>
            <div className={styles.modules}>
              <div><Activity size={20} aria-hidden="true" /><strong>Performance</strong><span>See the signals</span></div>
              <div><Boxes size={20} aria-hidden="true" /><strong>Capacity</strong><span>Plan the day</span></div>
              <div><Wallet size={20} aria-hidden="true" /><strong>Cash</strong><span>Stay in control</span></div>
              <div><Truck size={20} aria-hidden="true" /><strong>Fleet</strong><span>Keep it moving</span></div>
            </div>
            <div className={styles.connection} aria-hidden="true"><span /><ArrowDownToLine size={18} /><span /></div>
            <div className={styles.actionView}><span className={styles.actionIcon}><CircleCheck size={20} aria-hidden="true" /></span><div><strong>Clear priorities. Coordinated action.</strong><span>From station-level signals to the next step.</span></div><ArrowRight size={20} aria-hidden="true" /></div>
          </div>
          <p className={styles.storyFooter}>BUILT FOR THE PEOPLE WHO KEEP DROPX MOVING.</p>
        </section>
        <section className={styles.access} aria-labelledby="ops-signin-title">
          <div className={styles.card}>
            <div className={styles.cardTop}><Image src="/opspulse/mark.svg?v=2" alt="" width={40} height={40} unoptimized /><span><LockKeyhole size={13} aria-hidden="true" /> AUTHORISED ACCESS</span></div>
            <p className={styles.cardEyebrow}>WELCOME BACK</p>
            <h2 id="ops-signin-title">Ready to take <br />the next step?</h2>
            <p className={styles.cardIntro}>Sign in to OpsPulse and pick up where your operation needs you.</p>
            {initialMessage ? <div className={styles.notice} role="alert">{initialMessage}</div> : null}
            <form action={signInWithGoogle}>
              <input name="next" type="hidden" value={nextPath} />
              <GoogleSignInButton />
            </form>
            <p className={styles.accountHint}>Use your authorised DropX Google account.</p>
            <div className={styles.roleNote}><ShieldCheck size={20} aria-hidden="true" /><div><strong>Your workspace. Your assigned scope.</strong><p>Access is limited to your role and permitted locations.</p></div></div>
            <p className={styles.accessHelp}>Need access? Contact your DropX administrator.</p>
          </div>
          <div className={styles.apps}>
            <div className={styles.appsHeading}><MonitorSmartphone size={19} aria-hidden="true" /><div><strong>On the move? Take OpsPulse with you.</strong><p>Your operations workspace, wherever the day takes you.</p></div></div>
            <div className={styles.appActions}>
              <a href="/downloads/DropX-OpsPulse.apk" download><Download size={17} aria-hidden="true" /><span>Download for Android</span><ArrowRight size={15} aria-hidden="true" /></a>
              {installPrompt ? <button type="button" onClick={() => void installWebApp()}><MonitorSmartphone size={17} aria-hidden="true" />Install web app</button> : null}
            </div>
            <details className={styles.iphone}><summary>Using an iPhone or iPad?</summary><p>Open OpsPulse in Safari, tap Share, then select “Add to Home Screen”.</p></details>
            {installError ? <p className={styles.installError} role="status">{installError}</p> : null}
          </div>
        </section>
      </div>
      <footer className={styles.footer}><span>DropX Logistics · OpsPulse</span><span>From insight to action.</span></footer>
    </main>
  );
}
