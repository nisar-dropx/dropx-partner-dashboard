/** Coalesce timer, tab visibility and button refreshes into one request. */
export function createRefreshGate(now=Date.now, intervalMs=60_000) {
  let running=false, last=now();
  return {
    start(manual=false) {
      if(running || (!manual && now()-last<intervalMs)) return false;
      running=true;last=now();return true;
    },
    finish() { if(running) { running=false;last=now(); } },
  };
}
