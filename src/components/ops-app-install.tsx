"use client";

import { useEffect, useState } from "react";
import androidRelease from "../../public/downloads/opspulse-android.json";
import { Download, Monitor, Smartphone, Check, ChevronDown } from "lucide-react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
type Device = "android" | "ios" | "desktop";
const devices: { value: Device; label: string }[] = [
  { value: "android", label: "Android" },
  { value: "ios", label: "iPhone / iPad" },
  { value: "desktop", label: "Computer" },
];

export function OpsAppInstall({ compact = false }: { compact?: boolean }) {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [platform, setPlatform] = useState<Device>("desktop");
  const [device, setDevice] = useState<Device>("desktop");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent || "";
    const detected = /android/i.test(ua)
      ? "android"
      : /iphone|ipad|ipod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)
        ? "ios"
        : "desktop";
    setPlatform(detected);
    setDevice(detected);
    const standalone = window.matchMedia("(display-mode: standalone)");
    const sync = () => setInstalled(standalone.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
    const capture = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const complete = () => {
      setInstalled(true);
      setPrompt(null);
      setMessage("OpsPulse is installed. Open it from your apps next time.");
    };
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
    if (!prompt) {
      setMessage("Use your browser’s install option shown below.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      setMessage(choice.outcome === "accepted"
        ? "Installation accepted. Your browser will finish adding OpsPulse."
        : "You can install OpsPulse whenever you’re ready.");
    } catch {
      setMessage("Use your browser’s install option shown below.");
    } finally {
      setPrompt(null);
      setBusy(false);
    }
  }

  const content = (
    <div className="ops-install-content">
      <div className="ops-install-devices" role="group" aria-label="Choose your device">
        {devices.map((item) => (
          <button key={item.value} type="button" aria-pressed={device === item.value}
            onClick={() => { setDevice(item.value); setMessage(""); }}>
            {item.label}
          </button>
        ))}
      </div>

      {device === "android" ? (
        <>
          <a className="ops-install-primary" href={androidRelease.url} download={`DropX-OpsPulse-${androidRelease.version}.apk`}>
            <Download size={18} aria-hidden="true" /> Download Android app
          </a>
          <p className="ops-install-message">v{androidRelease.version} · Android 7.0+ · {(androidRelease.bytes / 1024 / 1024).toFixed(1)} MB</p>
        </>
      ) : null}

      {device === platform && platform === "desktop" ? (
        <button type="button" className="ops-install-primary" disabled={busy || installed} onClick={() => void install()}>
          {installed ? <Check size={18} aria-hidden="true" /> : <Download size={18} aria-hidden="true" />}
          {installed ? "App installed" : busy ? "Opening installer…" : "Install OpsPulse"}
        </button>
      ) : null}

      {message ? <p className="ops-install-message" role="status">{message}</p> : null}

      <div className="ops-install-instructions">
        {device === "android" ? (
          <p>Open the downloaded APK to install or update OpsPulse. Keep Chrome up to date for Google sign-in and camera reporting.</p>
        ) : device === "ios" ? (
          <p>In <strong>Safari</strong>, tap <strong>Share → Add to Home Screen</strong>. Enable “Open as Web App” if shown.</p>
        ) : (
          <>
            <p><strong>Chrome / Edge:</strong> use the install icon in the address bar.</p>
            <p><strong>Safari on Mac:</strong> File → Add to Dock (macOS Sonoma or later).</p>
          </>
        )}
      </div>

      {device === "android" ? (
        <details className="ops-install-alternative">
          <summary>Use the browser app instead</summary>
          <p>In Chrome, tap ⋮ → Install app or Add to Home screen.</p>
        </details>
      ) : null}
    </div>
  );

  if (compact) {
    return (
      <details className="ops-install is-compact">
        <summary className="ops-install-toggle">
          <Monitor size={18} aria-hidden="true" />
          <span>Get the OpsPulse app</span>
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        {content}
      </details>
    );
  }
  return (
    <section className="ops-install" aria-label="Get the OpsPulse app">
      <div className="ops-install-heading">
        <Smartphone size={20} aria-hidden="true" />
        <strong>Install on your device</strong>
      </div>
      {content}
    </section>
  );
}
