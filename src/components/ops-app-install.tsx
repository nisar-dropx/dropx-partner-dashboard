"use client";

import { useEffect, useState } from "react";
import androidRelease from "../../public/downloads/opspulse-android.json";
import { Download, Monitor, Smartphone, Check, Chrome } from "lucide-react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function isAndroidUa(ua: string) {
  return /android/i.test(ua);
}

function isIosUa(ua: string) {
  return /iphone|ipad|ipod/i.test(ua);
}

export function OpsAppInstall({ compact = false }: { compact?: boolean }) {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [fromAndroidApp, setFromAndroidApp] = useState(false);
  const [platform, setPlatform] = useState<"android" | "ios" | "desktop">("desktop");
  const [instructions, setInstructions] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent || "";
    const android = isAndroidUa(ua);
    const ios = isIosUa(ua);
    setPlatform(android ? "android" : ios ? "ios" : "desktop");
    setInstructions(true);

    const params = new URLSearchParams(window.location.search);
    setFromAndroidApp(params.get("source") === "android-app");

    const standalone = window.matchMedia("(display-mode: standalone)");
    const sync = () =>
      setInstalled(
        standalone.matches ||
          Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
      );
    const capture = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const complete = () => {
      setInstalled(true);
      setPrompt(null);
      setMessage("OpsPulse is on your home screen. Open it from there next time.");
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

  async function installDesktop() {
    if (!prompt) {
      setInstructions(true);
      setMessage(
        "Use Chrome or Edge → install icon in the address bar, or the steps below.",
      );
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      setMessage(
        choice.outcome === "accepted"
          ? "Installation accepted. Your browser will finish adding OpsPulse."
          : "You can install OpsPulse whenever you’re ready.",
      );
    } catch {
      setMessage("Use your browser’s install option. Steps are below.");
      setInstructions(true);
    } finally {
      setPrompt(null);
      setBusy(false);
    }
  }

  return (
    <section
      className={`ops-install${compact ? " is-compact" : ""}`}
      aria-label="Get the OpsPulse app"
    >
      <div className="ops-install-heading">
        <img src="/opspulse/icon-192.png?v=2" alt="" width="36" height="36" />
        <div>
          <strong>Install OpsPulse</strong>
          <span>
            {installed
              ? "Already installed on this device"
              : "Recommended: Chrome home screen (temporary while the store app is finished)"}
          </span>
        </div>
      </div>

      {fromAndroidApp ? (
        <p className="ops-install-banner" role="status">
          The Android package is still being stabilised. If this window closed
          before, install from Chrome using the steps below — that path stays
          open reliably.
        </p>
      ) : null}

      <div className="ops-install-recommend">
        <div className="ops-install-recommend-head">
          <Chrome size={18} aria-hidden="true" />
          <div>
            <strong>Recommended · Chrome install</strong>
            <small>Works today on Android phones</small>
          </div>
        </div>
        <ol className="ops-install-steps">
          <li>
            Open <b>ops.dropxlogistics.com</b> in <b>Chrome</b>
          </li>
          <li>
            Tap the <b>⋮</b> menu (top right)
          </li>
          <li>
            Choose <b>Install app</b> or <b>Add to Home screen</b>
          </li>
          <li>
            Tap <b>Install</b> — OpsPulse appears on your home screen
          </li>
        </ol>
        {platform === "android" && prompt ? (
          <button
            type="button"
            className="ops-install-primary"
            disabled={busy || installed}
            onClick={() => void installDesktop()}
          >
            {installed ? (
              <Check size={18} aria-hidden="true" />
            ) : (
              <Smartphone size={18} aria-hidden="true" />
            )}
            <span>
              <strong>
                {installed
                  ? "Already installed"
                  : busy
                    ? "Opening installer…"
                    : "Install OpsPulse"}
              </strong>
              <small>Uses Chrome’s install prompt</small>
            </span>
          </button>
        ) : null}
      </div>

      <div className="ops-install-actions">
        <button
          type="button"
          onClick={() => void installDesktop()}
          disabled={busy || installed}
        >
          {installed ? (
            <Check size={18} aria-hidden="true" />
          ) : (
            <Monitor size={18} aria-hidden="true" />
          )}
          <span>
            <strong>
              {installed
                ? "App installed"
                : busy
                  ? "Opening installer…"
                  : "Install on Windows / Mac"}
            </strong>
            <small>Chrome or Edge · automatic updates</small>
          </span>
        </button>
        <a
          href={androidRelease.url}
          download={`DropX-OpsPulse-${androidRelease.version}.apk`}
          className="ops-install-apk"
        >
          <Download size={18} aria-hidden="true" />
          <span>
            <strong>Android APK (beta)</strong>
            <small>
              v{androidRelease.version} · may close on some phones — prefer
              Chrome install above
            </small>
          </span>
        </a>
      </div>

      {message ? (
        <p className="ops-install-message" role="status">
          {message}
        </p>
      ) : null}

      {compact ? (
        <button
          className="ops-install-help"
          type="button"
          aria-expanded={instructions}
          onClick={() => setInstructions(!instructions)}
        >
          <Smartphone size={14} aria-hidden="true" />
          {instructions ? "Hide" : "Show"} iPhone &amp; other devices
        </button>
      ) : null}

      {instructions ? (
        <div className="ops-install-instructions">
          <p>
            <strong>iPhone / iPad · Safari</strong>
            <br />
            Tap Share → Add to Home Screen. Enable “Open as Web App” if shown.
          </p>
          <p>
            <strong>Windows / Mac · Chrome or Edge</strong>
            <br />
            Use Install above when available, or the install icon in the address
            bar.
          </p>
          <p>
            <strong>Mac · Safari</strong>
            <br />
            On macOS Sonoma or later, File → Add to Dock.
          </p>
          <p className="ops-install-note">
            Use the Chrome home-screen method until the official Play/store
            package is released. Live operations need internet; access matches
            the website.
          </p>
        </div>
      ) : null}
    </section>
  );
}
