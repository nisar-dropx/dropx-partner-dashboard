"use client";

import { useEffect, useState } from "react";
import androidRelease from "../../public/downloads/opspulse-android.json";
import { Download, Monitor, Smartphone, Check } from "lucide-react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function OpsAppInstall({ compact = false }: { compact?: boolean }) {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [instructions, setInstructions] = useState(!compact);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)");
    const sync = () => setInstalled(standalone.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
    const capture = (event: Event) => { event.preventDefault(); setPrompt(event as InstallPromptEvent); };
    const complete = () => { setInstalled(true); setPrompt(null); setMessage("OpsPulse is installed. Open it from your apps."); };
    sync();
    standalone.addEventListener("change", sync);
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", complete);
    return () => {
      standalone.removeEventListener("change", sync);
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", complete);
    };
  }, []);

  async function install() {
    if (!prompt) { setInstructions(true); return; }
    setBusy(true);
    setMessage("");
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      setMessage(choice.outcome === "accepted" ? "Installation accepted. Your browser will finish adding OpsPulse." : "You can install OpsPulse whenever you’re ready.");
    } catch {
      setMessage("Use your browser’s install option. Instructions are below.");
      setInstructions(true);
    } finally { setPrompt(null); setBusy(false); }
  }

  return <section className={`ops-install${compact ? " is-compact" : ""}`} aria-label="Get the OpsPulse app">
    <div className="ops-install-heading"><img src="/opspulse/icon-192.png?v=2" alt="" width="36" height="36" /><div><strong>OpsPulse, on your device</strong><span>Your workspace. Its own app window.</span></div></div>
    <div className="ops-install-actions">
      <a href={androidRelease.url} download={`DropX-OpsPulse-${androidRelease.version}.apk`}><Download size={18} aria-hidden="true" /><span><strong>Android APK</strong><small>Version {androidRelease.version} · Android {androidRelease.minimumAndroid}+</small></span></a>
      <button type="button" onClick={() => void install()} disabled={busy || installed}>
        {installed ? <Check size={18} aria-hidden="true" /> : <Monitor size={18} aria-hidden="true" />}<span><strong>{installed ? "App installed" : busy ? "Opening installer…" : "Install on Windows / Mac"}</strong><small>Desktop app · automatic updates</small></span>
      </button>
    </div>
    {message && <p className="ops-install-message" role="status">{message}</p>}
    {compact && <button className="ops-install-help" type="button" aria-expanded={instructions} onClick={() => setInstructions(!instructions)}><Smartphone size={14} aria-hidden="true" /> Installation help & iPhone</button>}
    {instructions && <div className="ops-install-instructions">
      <p><strong>Windows / Mac · Chrome or Edge</strong><br />Choose Install above when available, or use the install icon in the address bar. OpsPulse opens in its own window with its own icon.</p>
      <p><strong>Mac · Safari</strong><br />On macOS Sonoma or later, choose File → Add to Dock.</p>
      <p><strong>iPhone / iPad · Safari</strong><br />Tap Share → Add to Home Screen. Enable “Open as Web App” if shown.</p>
      <p><strong>Android APK</strong><br />Open the downloaded APK to install or update OpsPulse. Keep the existing app installed to preserve your setup.</p>
      <p className="ops-install-note">An internet connection is required for live operations. Access and permissions are the same as on the website. Desktop installation uses your browser’s app installer.</p>
    </div>}
  </section>;
}
