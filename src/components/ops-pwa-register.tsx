"use client";

import { opsDemoPaths } from "@/lib/ops-pulse/demo/surface";
import { useEffect, useState } from "react";

export function OpsPwaRegister() {
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    if ((opsDemoPaths as readonly string[]).includes(window.location.pathname)) return;
    if (!("serviceWorker" in navigator)) return;
    const hadController = Boolean(navigator.serviceWorker.controller);
    const onControllerChange = () => {
      // Never interrupt an in-progress form. Let the operator choose when to
      // reload a newly activated release.
      if (hadController) setUpdateReady(true);
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    const register = () => navigator.serviceWorker.register("/sw.js", { scope: "/" })
      .then((registration) => registration.update())
      .catch(() => undefined);
    if (document.readyState === "complete") void register();
    else window.addEventListener("load", register, { once: true });
    return () => {
      window.removeEventListener("load", register);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  if (!updateReady) return null;
  return (
    <div className="ops-release-update" role="status" aria-live="polite">
      <span>A newer OpsPulse version is ready.</span>
      <button type="button" onClick={() => window.location.reload()}>Reload now</button>
    </div>
  );
}
