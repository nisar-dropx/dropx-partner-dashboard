/** Nested-safe body scroll lock for stacked modals. */

let locks = 0;

export function lockBodyScroll() {
  if (typeof document === "undefined") return () => {};
  locks += 1;
  if (locks === 1) {
    document.body.style.overflow = "hidden";
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks = Math.max(0, locks - 1);
    if (locks === 0) {
      document.body.style.overflow = "";
    }
  };
}

/** Clear a stuck lock (e.g. after a modal race left overflow:hidden on body). */
export function resetBodyScrollLock() {
  locks = 0;
  if (typeof document !== "undefined") {
    document.body.style.overflow = "";
  }
}
