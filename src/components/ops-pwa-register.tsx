"use client";

import { opsDemoPaths } from "@/lib/ops-pulse/demo/surface";
import { useEffect } from "react";

export function OpsPwaRegister() {
  useEffect(() => {
    if ((opsDemoPaths as readonly string[]).includes(window.location.pathname)) return;
    if (!("serviceWorker" in navigator)) return;
    const register = () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    if (document.readyState === "complete") void register();
    else window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);
  return null;
}
